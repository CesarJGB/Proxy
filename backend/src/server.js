import crypto from 'node:crypto';
import http from 'node:http';
import { assertConfig, config } from './config.js';
import {
  authenticateToken,
  completeBuffered,
  sendBufferedAsSse,
  streamPassthrough,
} from './proxy.js';

assertConfig();

function parseByteLimit(value) {
  const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) return 12 * 1024 * 1024;
  const number = Number(match[1]);
  const unit = match[2] || 'b';
  const multipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.floor(number * multipliers[unit]);
}

const bodyLimitBytes = parseByteLimit(config.bodyLimit);

function originAllowed(origin) {
  if (!origin) return true;
  if (config.corsOrigins.includes('*')) return true;
  return config.corsOrigins.includes(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : (origin || ''));
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > bodyLimitBytes) {
      const error = new Error(`Request body exceeds BODY_LIMIT (${config.bodyLimit})`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body is not valid JSON');
    error.status = 400;
    throw error;
  }
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

function summarizeDetails(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value !== 'object') return value;
  const clone = structuredClone(value);
  if (clone?.error?.metadata?.raw) clone.error.metadata.raw = '[redacted]';
  return clone;
}

async function handleChat(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Proxy-Request-Id', requestId);

  if (!authenticateToken(bearerToken(req))) {
    return sendJson(res, 401, { error: { message: 'Invalid proxy API key', type: 'authentication_error' } });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: { message: error.message, type: 'invalid_request_error' } });
  }

  if (!Array.isArray(body.messages)) {
    return sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
  }
  if (!config.forceModel && !body.model) {
    return sendJson(res, 400, { error: { message: 'model is required unless FORCE_MODEL is configured', type: 'invalid_request_error' } });
  }

  const clientWantsStream = body.stream === true;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Upstream timeout')), config.requestTimeoutMs);

  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('Client disconnected'));
  });

  try {
    if (clientWantsStream && config.outputMode === 'prompt') {
      const meta = await streamPassthrough(body, res, controller.signal);
      console.log(JSON.stringify({
        level: 'info', request_id: requestId, route: 'chat', stream: true,
        model: config.forceModel || body.model,
        provider: config.providers.join(',') || 'auto',
        elapsed_ms: Date.now() - started,
        upstream_bytes: meta?.bytes || 0,
      }));
      return;
    }

    const { json, meta } = await completeBuffered(body, controller.signal);
    if (clientWantsStream) sendBufferedAsSse(res, json);
    else sendJson(res, 200, json);

    console.log(JSON.stringify({
      level: 'info', request_id: requestId, route: 'chat', stream: clientWantsStream,
      model: config.forceModel || body.model,
      provider: config.providers.join(',') || 'auto',
      output_mode: config.outputMode,
      elapsed_ms: meta.elapsed_ms,
      attempts: meta.attempts,
      rewritten: meta.rewritten,
      visible_chars: meta.visible_chars,
      reasoning_chars: meta.reasoning_chars,
      messages: body.messages.length,
      ...(config.logPromptContent ? { prompt_preview: JSON.stringify(body.messages).slice(0, 1000) } : {}),
    }));
  } catch (error) {
    const aborted = controller.signal.aborted;
    const status = error?.status || (aborted ? 504 : 502);
    const message = aborted ? 'Upstream request timed out or was cancelled' : (error?.message || 'Proxy error');

    console.error(JSON.stringify({
      level: 'error', request_id: requestId, route: 'chat', status,
      elapsed_ms: Date.now() - started,
      message,
      details: error?.details && !config.logPromptContent ? summarizeDetails(error.details) : error?.details,
    }));

    if (!res.headersSent) {
      return sendJson(res, status, {
        error: {
          message,
          type: 'proxy_error',
          request_id: requestId,
          ...(error?.details ? { upstream: summarizeDetails(error.details) } : {}),
        },
      });
    }
    if (!res.writableEnded) res.end();
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  const origin = req.headers.origin;

  if (req.method === 'OPTIONS') {
    res.statusCode = originAllowed(origin) ? 204 : 403;
    return res.end();
  }
  if (origin && !originAllowed(origin)) {
    return sendJson(res, 403, { error: { message: 'Origin not allowed' } });
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      name: 'janitor-openrouter-proxy',
      status: 'ok',
      endpoint: '/v1/chat/completions',
      output_mode: config.outputMode,
      provider_pinned: config.providers.length > 0,
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()) });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }

  return sendJson(res, 404, { error: { message: 'Not found' } });
});

server.requestTimeout = config.requestTimeoutMs + 5000;
server.headersTimeout = Math.min(server.requestTimeout, 65000);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[proxy] listening on 0.0.0.0:${config.port}`);
  console.log(`[proxy] output mode: ${config.outputMode}`);
  console.log(`[proxy] provider: ${config.providers.join(', ') || 'OpenRouter automatic routing'}`);
  console.log(`[proxy] model: ${config.forceModel || 'client-selected'}`);
});
