import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { assertConfig, config } from './config.js';
import {
  authenticateToken,
  completeBuffered,
  sendBufferedAsSse,
  streamPassthrough,
  streamSmart,
} from './proxy.js';
import {
  logAttemptFailed,
  logRequestCompleted,
  logRequestFailed,
  logRequestStarted,
  sanitizeValue,
} from './logger.js';

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
  const auth = req.headers?.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export async function handleChat(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Proxy-Request-Id', requestId);

  const started = Date.now();
  let clientDisconnected = false;
  let timedOut = false;
  let terminalLogged = false;
  let body = null;
  let clientWantsStream = false;
  let currentStage = 'auth';
  let currentAttempt = 0;
  let totalAttempts = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Upstream timeout'));
  }, config.requestTimeoutMs);

  function onClientClose() {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort(new Error('Client disconnected'));
    }
  }

  res.on('close', onClientClose);
  req.on('aborted', onClientClose);
  req.on('error', onClientClose);

  function emitTerminalSuccess(meta) {
    if (terminalLogged) return;
    terminalLogged = true;
    logRequestCompleted({
      requestId,
      route: 'chat',
      stream: clientWantsStream,
      model: config.forceModel || body?.model || null,
      provider: config.providers.join(',') || 'auto',
      outputMode: config.outputMode,
      elapsedMs: meta?.elapsed_ms ?? (Date.now() - started),
      generationMs: meta?.generation_ms ?? 0,
      rewriteMs: meta?.rewrite_ms ?? 0,
      decisionMs: meta?.decision_ms ?? 0,
      attempts: meta?.attempts ?? Math.max(totalAttempts, 1),
      rewritten: meta?.rewritten ?? false,
      languageDetected: meta?.language_detected ?? 'unknown',
      streamStrategy: meta?.stream_strategy,
      translatorModel: meta?.translator_model ?? null,
      visibleChars: meta?.visible_chars ?? (meta?.bytes != null ? undefined : 0),
      sourceChars: meta?.source_chars,
      reasoningChars: meta?.reasoning_chars ?? 0,
      messages: body?.messages?.length ?? 0,
      promptPreview: config.logPromptContent && body?.messages ? JSON.stringify(body.messages).slice(0, 1000) : undefined,
    });
  }

  function emitTerminalFailure(err, statusOverride) {
    if (terminalLogged) return;
    terminalLogged = true;
    const clientStatus = statusOverride || err?.status || (clientDisconnected ? 499 : (timedOut ? 504 : 502));
    logRequestFailed({
      requestId,
      route: 'chat',
      stream: clientWantsStream,
      model: config.forceModel || body?.model || null,
      provider: config.providers.join(',') || 'auto',
      outputMode: config.outputMode,
      attempt: currentAttempt > 0 ? currentAttempt : (totalAttempts > 0 ? totalAttempts : null),
      attempts: totalAttempts,
      stage: currentStage,
      elapsedMs: Date.now() - started,
      error: err,
      clientDisconnected,
      timedOut,
      clientStatus,
      details: err?.details,
    });
  }

  function onAttemptFailed(err, info = {}) {
    currentAttempt = info.attempt || currentAttempt || 1;
    totalAttempts = Math.max(totalAttempts, info.attempts || currentAttempt);
    currentStage = info.stage || currentStage;
    logAttemptFailed({
      requestId,
      route: 'chat',
      stream: clientWantsStream,
      model: config.forceModel || body?.model || null,
      provider: config.providers.join(',') || 'auto',
      outputMode: config.outputMode,
      attempt: currentAttempt,
      attempts: totalAttempts,
      stage: currentStage,
      elapsedMs: Date.now() - started,
      error: err,
      errorType: info.errorType,
      errorCode: info.errorCode,
      upstreamStatus: info.upstreamStatus,
      clientDisconnected,
      timedOut,
      retryable: Boolean(info.retryable),
      details: err?.details,
    });
  }

  try {
    currentStage = 'auth';
    if (!authenticateToken(bearerToken(req))) {
      const authErr = new Error('Invalid proxy API key');
      authErr.status = 401;
      authErr.type = 'authentication_error';
      emitTerminalFailure(authErr, 401);
      return sendJson(res, 401, { error: { message: 'Invalid proxy API key', type: 'authentication_error' } });
    }

    currentStage = 'body_read';
    try {
      body = await readJsonBody(req);
    } catch (error) {
      emitTerminalFailure(error, error.status || 400);
      return sendJson(res, error.status || 400, { error: { message: error.message, type: 'invalid_request_error' } });
    }

    currentStage = 'validation';
    clientWantsStream = body?.stream === true;

    if (!Array.isArray(body?.messages)) {
      const valErr = new Error('messages must be an array');
      valErr.status = 400;
      valErr.type = 'invalid_request_error';
      emitTerminalFailure(valErr, 400);
      return sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
    }

    if (!config.forceModel && !body?.model) {
      const valErr = new Error('model is required unless FORCE_MODEL is configured');
      valErr.status = 400;
      valErr.type = 'invalid_request_error';
      emitTerminalFailure(valErr, 400);
      return sendJson(res, 400, { error: { message: 'model is required unless FORCE_MODEL is configured', type: 'invalid_request_error' } });
    }

    logRequestStarted({
      requestId,
      route: 'chat',
      stream: clientWantsStream,
      model: config.forceModel || body.model,
      provider: config.providers.join(',') || 'auto',
      outputMode: config.outputMode,
      messages: body.messages.length,
    });

    const context = {
      requestId,
      started,
      stage: 'upstream_connect',
      attempt: 1,
      attempts: 1,
      onAttemptFailed,
    };

    if (clientWantsStream && config.outputMode === 'prompt') {
      currentStage = 'stream';
      currentAttempt = 1;
      totalAttempts = 1;
      const meta = await streamPassthrough(body, res, controller.signal, context);
      emitTerminalSuccess(meta);
      return;
    }

    if (clientWantsStream && config.outputMode === 'smart') {
      currentStage = 'stream';
      currentAttempt = 1;
      totalAttempts = 1;
      const meta = await streamSmart(body, res, controller.signal, context);
      emitTerminalSuccess(meta);
      return;
    }

    currentStage = 'upstream_connect';
    currentAttempt = 1;
    totalAttempts = 1;
    const { json, meta } = await completeBuffered(body, controller.signal, context);
    if (clientWantsStream) sendBufferedAsSse(res, json);
    else sendJson(res, 200, json);

    emitTerminalSuccess(meta);
  } catch (error) {
    currentStage = error?.stage || currentStage;
    const status = error?.status || (clientDisconnected ? 499 : (timedOut ? 504 : 502));
    const message = clientDisconnected
      ? 'Client disconnected'
      : (timedOut ? 'Upstream request timed out' : (error?.message || 'Proxy error'));

    emitTerminalFailure(error, status);

    if (!res.headersSent) {
      return sendJson(res, status, {
        error: {
          message,
          type: 'proxy_error',
          request_id: requestId,
          ...(error?.details ? { upstream: sanitizeValue(error.details) } : {}),
        },
      });
    }

    // If an SSE response already started, close it cleanly enough for Janitor to stop waiting.
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({
          error: { message, type: 'proxy_error', request_id: requestId },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch {}
      try {
        res.end();
      } catch {}
    }
  } finally {
    clearTimeout(timeout);
  }
}

export const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    const origin = req.headers?.origin;

    if (req.method === 'OPTIONS') {
      res.statusCode = originAllowed(origin) ? 204 : 403;
      return res.end();
    }
    if (origin && !originAllowed(origin)) {
      return sendJson(res, 403, { error: { message: 'Origin not allowed' } });
    }

    const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        name: 'janitor-openrouter-proxy',
        version: '2',
        status: 'ok',
        endpoint: '/v1/chat/completions',
        output_mode: config.outputMode,
        translator_model: config.translatorModel,
        provider_pinned: config.providers.length > 0,
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        version: '2',
        output_mode: config.outputMode,
        uptime_s: Math.round(process.uptime()),
      });
    }

    if (url.pathname === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        const requestId = crypto.randomUUID();
        res.setHeader('X-Proxy-Request-Id', requestId);
        logRequestFailed({
          requestId,
          route: 'chat',
          stage: 'routing',
          elapsedMs: 0,
          errorType: 'invalid_request_error',
          errorCode: 405,
          errorMessage: 'Method not allowed',
          clientStatus: 405,
          final: true,
        });
        return sendJson(res, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error' } });
      }
      return handleChat(req, res);
    }

    return sendJson(res, 404, { error: { message: 'Not found' } });
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: 'Internal server error', type: 'internal_error' } });
    }
  }
});

server.requestTimeout = config.requestTimeoutMs + 5000;
server.headersTimeout = Math.min(server.requestTimeout, 65000);

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) {
  assertConfig();
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[proxy] listening on 0.0.0.0:${config.port}`);
    console.log(`[proxy] output mode: ${config.outputMode}`);
    console.log(`[proxy] provider: ${config.providers.join(', ') || 'OpenRouter automatic routing'}`);
    console.log(`[proxy] model: ${config.forceModel || 'client-selected'}`);
    console.log(`[proxy] translator: ${config.translatorModel}`);
  });
}
