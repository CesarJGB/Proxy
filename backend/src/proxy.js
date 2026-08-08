import crypto from 'node:crypto';
import { config } from './config.js';
import { buildRewriteMessages, injectLanguagePolicy, shouldRewriteToSpanish } from './language.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function authenticateToken(token) {
  return safeEqual(token, config.proxyApiKey);
}

export function buildProviderConfig(providers = config.providers, allowFallbacks = config.allowFallbacks) {
  const provider = {};
  if (providers.length) {
    provider.only = providers;
    provider.order = providers;
    provider.allow_fallbacks = allowFallbacks;
  } else if (!allowFallbacks) {
    // No explicit provider = leave OpenRouter's normal routing behavior intact.
    // allow_fallbacks is intentionally not set unless a provider allowlist exists.
  }
  if (config.providerSort) provider.sort = config.providerSort;
  if (config.dataCollection) provider.data_collection = config.dataCollection;
  if (config.requireParameters) provider.require_parameters = true;
  return Object.keys(provider).length ? provider : undefined;
}

export function preparePayload(input, { stream, retry = false } = {}) {
  const payload = structuredClone(input || {});
  payload.messages = injectLanguagePolicy(payload.messages, config.languagePolicyEnabled);
  payload.stream = Boolean(stream);

  if (config.forceModel) payload.model = config.forceModel;

  const provider = buildProviderConfig();
  if (provider) payload.provider = provider;

  if (config.minCompletionTokens > 0) {
    if ('max_completion_tokens' in payload) {
      payload.max_completion_tokens = Math.max(Number(payload.max_completion_tokens) || 0, config.minCompletionTokens);
    } else {
      payload.max_tokens = Math.max(Number(payload.max_tokens) || 0, config.minCompletionTokens);
    }
  }

  if (config.reasoningEffort || config.reasoningMaxTokens || config.reasoningExclude) {
    payload.reasoning = typeof payload.reasoning === 'object' && payload.reasoning ? { ...payload.reasoning } : {};
    if (config.reasoningEffort) payload.reasoning.effort = config.reasoningEffort;
    if (config.reasoningMaxTokens) payload.reasoning.max_tokens = config.reasoningMaxTokens;
    if (config.reasoningExclude) payload.reasoning.exclude = true;
    delete payload.include_reasoning;
  }

  if (retry) {
    payload.messages.push({
      role: 'system',
      content: 'A visible final answer is required. Do not end after reasoning. Return the actual roleplay response in Spanish in the assistant content field.',
    });
    if (payload.reasoning && typeof payload.reasoning === 'object') {
      payload.reasoning = { ...payload.reasoning, exclude: true };
      if (!config.reasoningEffort && 'effort' in payload.reasoning) payload.reasoning.effort = 'minimal';
    }
  }

  return payload;
}

function openRouterHeaders() {
  const headers = {
    Authorization: `Bearer ${config.openRouterApiKey}`,
    'Content-Type': 'application/json',
  };
  if (config.openRouterReferer) headers['HTTP-Referer'] = config.openRouterReferer;
  if (config.openRouterTitle) headers['X-Title'] = config.openRouterTitle;
  return headers;
}

export async function callOpenRouter(payload, signal) {
  return fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify(payload),
    signal,
  });
}

export async function readOpenRouterJson(response) {
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`OpenRouter returned non-JSON response (${response.status})`);
    err.status = response.status || 502;
    err.details = text.slice(0, 2000);
    throw err;
  }
  if (!response.ok) {
    const err = new Error(json?.error?.message || `OpenRouter HTTP ${response.status}`);
    err.status = response.status;
    err.details = json;
    throw err;
  }
  return json;
}

export function extractContent(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }
  return '';
}

export function reasoningSize(json) {
  const message = json?.choices?.[0]?.message || {};
  const raw = message.reasoning || message.reasoning_content || '';
  const details = message.reasoning_details || [];
  return String(raw).length + JSON.stringify(details).length;
}

export async function rewriteToSpanish(text, originalModel, signal) {
  const model = config.translatorModel || originalModel;
  if (!model) throw new Error('Cannot rewrite output: no model is available');

  const payload = {
    model,
    messages: buildRewriteMessages(text),
    stream: false,
    temperature: 0.1,
  };

  const providers = config.translatorProvider.length ? config.translatorProvider : config.providers;
  const provider = buildProviderConfig(providers, config.allowFallbacks);
  if (provider) payload.provider = provider;

  const response = await callOpenRouter(payload, signal);
  const json = await readOpenRouterJson(response);
  const rewritten = extractContent(json).trim();
  if (!rewritten) throw new Error('Translator returned an empty response');
  return rewritten;
}

export async function completeBuffered(input, signal) {
  const started = Date.now();
  let attempts = 0;
  let json;
  let content = '';
  let reasoningChars = 0;

  while (attempts <= config.emptyResponseRetry) {
    const payload = preparePayload(input, { stream: false, retry: attempts > 0 });
    const response = await callOpenRouter(payload, signal);
    json = await readOpenRouterJson(response);
    content = extractContent(json).trim();
    reasoningChars = reasoningSize(json);
    if (content) break;
    attempts += 1;
  }

  if (!content) {
    const err = new Error('Model returned no visible content after retrying');
    err.status = 502;
    err.details = { reasoning_chars: reasoningChars, attempts: attempts + 1 };
    throw err;
  }

  let rewritten = false;
  const mode = config.outputMode;
  const shouldRewrite = mode === 'strict' || (mode === 'auto' && shouldRewriteToSpanish(content));
  if (shouldRewrite) {
    content = await rewriteToSpanish(content, config.forceModel || input?.model, signal);
    rewritten = true;
  }

  json.choices[0].message.content = content;
  if (json.choices[0].message.reasoning != null && config.reasoningExclude) delete json.choices[0].message.reasoning;
  if (json.choices[0].message.reasoning_content != null && config.reasoningExclude) delete json.choices[0].message.reasoning_content;
  if (json.choices[0].message.reasoning_details != null && config.reasoningExclude) delete json.choices[0].message.reasoning_details;

  return {
    json,
    meta: {
      elapsed_ms: Date.now() - started,
      attempts: attempts + 1,
      rewritten,
      visible_chars: content.length,
      reasoning_chars: reasoningChars,
    },
  };
}

export async function streamPassthrough(input, res, signal) {
  const payload = preparePayload(input, { stream: true });
  const response = await callOpenRouter(payload, signal);

  if (!response.ok) {
    const json = await readOpenRouterJson(response); // throws
    return json;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (!res.write(buffer)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
  return { bytes };
}

function splitForSse(text, size = 120) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export function sendBufferedAsSse(res, json) {
  const message = json?.choices?.[0]?.message || {};
  const id = json?.id || `chatcmpl-proxy-${crypto.randomUUID()}`;
  const model = json?.model || 'proxy';
  const created = json?.created || Math.floor(Date.now() / 1000);
  const content = typeof message.content === 'string' ? message.content : '';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const base = { id, object: 'chat.completion.chunk', created, model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  for (const part of splitForSse(content)) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
  }
  const finishReason = json?.choices?.[0]?.finish_reason || 'stop';
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
