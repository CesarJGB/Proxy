import crypto from 'node:crypto';
import { config } from './config.js';
import {
  buildRewriteMessages,
  detectOutputLanguage,
  injectLanguagePolicy,
  shouldRewriteToSpanish,
} from './language.js';

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

export function buildProviderConfig(
  providers = config.providers,
  allowFallbacks = config.allowFallbacks,
  { sort = config.providerSort } = {},
) {
  const provider = {};
  if (providers.length) {
    provider.only = providers;
    provider.order = providers;
    provider.allow_fallbacks = allowFallbacks;
  }
  if (sort) provider.sort = sort;
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
  const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
  const detailsSize = details.length ? JSON.stringify(details).length : 0;
  return String(raw).length + detailsSize;
}

function translatorPayload(text, originalModel, stream) {
  const model = config.translatorModel || originalModel;
  if (!model) throw new Error('Cannot rewrite output: no translator model is available');

  const payload = {
    model,
    messages: buildRewriteMessages(text),
    stream: Boolean(stream),
    temperature: 0.1,
    reasoning: {
      effort: config.translatorReasoningEffort || 'low',
      exclude: true,
    },
  };

  const providers = config.translatorProvider;
  // Do not inherit the roleplay model's global provider sort here:
  // the default translator model uses :nitro, which already means throughput sorting.
  const provider = buildProviderConfig(providers, config.allowFallbacks, { sort: '' });
  if (provider) payload.provider = provider;

  return payload;
}

export async function rewriteToSpanish(text, originalModel, signal) {
  const payload = translatorPayload(text, originalModel, false);
  const response = await callOpenRouter(payload, signal);
  const json = await readOpenRouterJson(response);
  const rewritten = extractContent(json).trim();
  if (!rewritten) throw new Error('Translator returned an empty response');
  return { text: rewritten, model: payload.model };
}

export async function completeBuffered(input, signal) {
  const started = Date.now();
  let attempts = 0;
  let json;
  let content = '';
  let reasoningChars = 0;
  let generationMs = 0;

  while (attempts <= config.emptyResponseRetry) {
    const generationStarted = Date.now();
    const payload = preparePayload(input, { stream: false, retry: attempts > 0 });
    const response = await callOpenRouter(payload, signal);
    json = await readOpenRouterJson(response);
    generationMs += Date.now() - generationStarted;

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
  let rewriteMs = 0;
  let translatorModel = null;
  const sourceLanguage = detectOutputLanguage(content);
  const mode = config.outputMode;
  const shouldRewrite = mode === 'strict' || ((mode === 'auto' || mode === 'smart') && shouldRewriteToSpanish(content));

  if (shouldRewrite) {
    const rewriteStarted = Date.now();
    const result = await rewriteToSpanish(content, config.forceModel || input?.model, signal);
    rewriteMs = Date.now() - rewriteStarted;
    content = result.text;
    translatorModel = result.model;
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
      generation_ms: generationMs,
      rewrite_ms: rewriteMs,
      attempts: attempts + 1,
      rewritten,
      language_detected: sourceLanguage,
      stream_strategy: rewritten ? 'buffered_rewrite' : 'buffered',
      translator_model: translatorModel,
      visible_chars: content.length,
      reasoning_chars: reasoningChars,
    },
  };
}

function startSseResponse(res) {
  if (res.headersSent) return;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

async function writeWithBackpressure(res, value) {
  if (!res.write(value)) {
    await new Promise((resolve) => res.once('drain', resolve));
  }
}

async function writeRawSseEvent(res, rawEvent) {
  if (!rawEvent) return;
  await writeWithBackpressure(res, `${rawEvent}\n\n`);
}

export async function* iterateSseEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index == null) break;

      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (raw) yield raw;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

export function parseSseEvent(rawEvent) {
  const lines = String(rawEvent || '').split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));

  if (!dataLines.length) return { kind: 'other', raw: rawEvent };

  const data = dataLines.join('\n');
  if (data.trim() === '[DONE]') return { kind: 'done', raw: rawEvent };

  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return { kind: 'other', raw: rawEvent };
  }

  const choice = json?.choices?.[0] || {};
  const delta = choice?.delta || {};

  let content = '';
  if (typeof delta.content === 'string') content = delta.content;
  else if (Array.isArray(delta.content)) {
    content = delta.content.map((part) => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }

  const reasoningRaw = delta.reasoning || delta.reasoning_content || '';
  const reasoningDetails = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
  const reasoningChars = String(reasoningRaw).length + (reasoningDetails.length ? JSON.stringify(reasoningDetails).length : 0);

  return {
    kind: 'chunk',
    raw: rawEvent,
    json,
    content,
    reasoningChars,
    finishReason: choice.finish_reason || null,
  };
}

export async function streamPassthrough(input, res, signal) {
  const payload = preparePayload(input, { stream: true });
  const response = await callOpenRouter(payload, signal);

  if (!response.ok) {
    const json = await readOpenRouterJson(response); // throws
    return json;
  }

  startSseResponse(res);

  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (!res.write(buffer)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
  return { bytes };
}

function completionBase(model) {
  return {
    id: `chatcmpl-proxy-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'proxy',
  };
}

async function writeSyntheticChunk(res, base, delta, finishReason = null) {
  const event = {
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  await writeWithBackpressure(res, `data: ${JSON.stringify(event)}\n\n`);
}

async function streamRewriteToSpanish(text, originalModel, res, signal) {
  const payload = translatorPayload(text, originalModel, true);
  const rewriteStarted = Date.now();
  const response = await callOpenRouter(payload, signal);
  if (!response.ok) {
    await readOpenRouterJson(response); // throws
  }

  const base = completionBase(payload.model);
  let startedVisibleOutput = false;
  let translatedChars = 0;
  let finishReason = 'stop';

  for await (const rawEvent of iterateSseEvents(response.body)) {
    const parsed = parseSseEvent(rawEvent);
    if (parsed.kind !== 'chunk') continue;

    if (parsed.finishReason) finishReason = parsed.finishReason;
    if (!parsed.content) continue;

    if (!startedVisibleOutput) {
      await writeSyntheticChunk(res, base, { role: 'assistant' });
      startedVisibleOutput = true;
    }

    translatedChars += parsed.content.length;
    await writeSyntheticChunk(res, base, { content: parsed.content });
  }

  if (!startedVisibleOutput || translatedChars === 0) {
    throw new Error('Translator returned an empty streaming response');
  }

  await writeSyntheticChunk(res, base, {}, finishReason);
  await writeWithBackpressure(res, 'data: [DONE]\n\n');

  return {
    rewrite_ms: Date.now() - rewriteStarted,
    translated_chars: translatedChars,
    translator_model: payload.model,
  };
}

export async function streamSmart(input, res, signal) {
  const totalStarted = Date.now();
  let attempts = 0;
  let bufferingNoticeSent = false;

  while (attempts <= config.emptyResponseRetry) {
    const generationStarted = Date.now();
    const payload = preparePayload(input, { stream: true, retry: attempts > 0 });
    const response = await callOpenRouter(payload, signal);
    if (!response.ok) {
      await readOpenRouterJson(response); // throws
    }

    // Only commit HTTP 200/SSE to Janitor after OpenRouter accepted the request.
    startSseResponse(res);
    if (!bufferingNoticeSent) {
      await writeWithBackpressure(res, ': proxy-smart-buffering\n\n');
      bufferingNoticeSent = true;
    }

    let bufferedEvents = [];
    let content = '';
    let reasoningChars = 0;
    let decision = 'pending';
    let languageDetected = 'unknown';
    let decisionMs = 0;
    let passThroughStarted = false;

    for await (const rawEvent of iterateSseEvents(response.body)) {
      const parsed = parseSseEvent(rawEvent);

      if (parsed.kind === 'chunk') {
        content += parsed.content || '';
        reasoningChars += parsed.reasoningChars || 0;
      }

      if (decision === 'pending') {
        bufferedEvents.push(rawEvent);

        if (content.length >= config.smartDetectChars) {
          languageDetected = detectOutputLanguage(content);

          if (languageDetected === 'en') {
            decision = 'rewrite';
            decisionMs = Date.now() - generationStarted;
            bufferedEvents = [];
          } else if (languageDetected === 'es') {
            decision = 'pass';
            decisionMs = Date.now() - generationStarted;
            for (const event of bufferedEvents) await writeRawSseEvent(res, event);
            bufferedEvents = [];
            passThroughStarted = true;
          } else if (content.length >= config.smartMaxDetectChars) {
            decision = shouldRewriteToSpanish(content) ? 'rewrite' : 'pass';
            decisionMs = Date.now() - generationStarted;
            if (decision === 'pass') {
              for (const event of bufferedEvents) await writeRawSseEvent(res, event);
              passThroughStarted = true;
            }
            bufferedEvents = [];
          }
        }
      } else if (decision === 'pass') {
        await writeRawSseEvent(res, rawEvent);
      }
      // decision === 'rewrite': continue consuming source silently.
    }

    const generationMs = Date.now() - generationStarted;
    const trimmedContent = content.trim();

    if (!trimmedContent) {
      attempts += 1;
      if (attempts <= config.emptyResponseRetry) {
        await writeWithBackpressure(res, ': proxy-retrying-empty-response\n\n');
        continue;
      }

      const err = new Error('Model returned no visible content after retrying');
      err.status = 502;
      err.details = { reasoning_chars: reasoningChars, attempts: attempts + 1 };
      throw err;
    }

    if (decision === 'pending') {
      languageDetected = detectOutputLanguage(trimmedContent);
      decision = shouldRewriteToSpanish(trimmedContent) ? 'rewrite' : 'pass';
      decisionMs = generationMs;

      if (decision === 'pass') {
        for (const event of bufferedEvents) await writeRawSseEvent(res, event);
        passThroughStarted = true;
      }
      bufferedEvents = [];
    }

    if (decision === 'pass') {
      // Source stream normally carries its own [DONE]; close the HTTP response too.
      if (!res.writableEnded) res.end();
      return {
        elapsed_ms: Date.now() - totalStarted,
        generation_ms: generationMs,
        rewrite_ms: 0,
        decision_ms: decisionMs,
        attempts: attempts + 1,
        rewritten: false,
        language_detected: languageDetected,
        stream_strategy: passThroughStarted ? 'smart_passthrough' : 'smart_buffered_passthrough',
        translator_model: null,
        visible_chars: trimmedContent.length,
        reasoning_chars: reasoningChars,
      };
    }

    const rewrite = await streamRewriteToSpanish(
      trimmedContent,
      config.forceModel || input?.model,
      res,
      signal,
    );
    res.end();

    return {
      elapsed_ms: Date.now() - totalStarted,
      generation_ms: generationMs,
      rewrite_ms: rewrite.rewrite_ms,
      decision_ms: decisionMs,
      attempts: attempts + 1,
      rewritten: true,
      language_detected: languageDetected,
      stream_strategy: 'smart_rewrite_stream',
      translator_model: rewrite.translator_model,
      visible_chars: rewrite.translated_chars,
      source_chars: trimmedContent.length,
      reasoning_chars: reasoningChars,
    };
  }

  throw new Error('Unexpected smart stream state');
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

  startSseResponse(res);

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
