import crypto from 'node:crypto';
import { config } from './config.js';
import { stripVeniceReasoning, veniceError, venicePayload, veniceReasoningDelta } from './venice.js';
import {
  buildRewriteMessages,
  detectOutputLanguage,
  injectLanguagePolicy,
  shouldRewriteToSpanish,
} from './language.js';

const IS_VENICE = config.aiProvider === 'venice';
const { url: UPSTREAM_URL, name: UPSTREAM_NAME, apiKey: UPSTREAM_KEY } = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', name: 'OpenRouter', apiKey: config.openRouterApiKey },
  deepseek: { url: 'https://api.deepseek.com/chat/completions', name: 'DeepSeek', apiKey: config.deepSeekApiKey },
  venice: { url: 'https://api.venice.ai/api/v1/chat/completions', name: 'Venice', apiKey: config.veniceApiKey },
}[config.aiProvider];

// Only documented DeepSeek request fields; leave message contents and history intact.
const DEEPSEEK_FIELDS = new Set([
  'model', 'messages', 'stream', 'stream_options', 'max_tokens', 'thinking',
  'reasoning_effort', 'temperature', 'top_p', 'stop', 'response_format',
  'tools', 'tool_choice', 'logprobs', 'top_logprobs', 'user_id',
]);

function deepSeekPayload(payload) {
  const result = Object.fromEntries(Object.entries(payload).filter(([key]) => DEEPSEEK_FIELDS.has(key)));
  // DeepSeek rejects stream_options on buffered requests (including empty-response retries).
  if (!result.stream) delete result.stream_options;
  else if (result.stream_options) {
    result.stream_options = { include_usage: result.stream_options.include_usage };
  }
  return result;
}

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

  if (config.aiProvider === 'openrouter') {
    const provider = buildProviderConfig();
    if (provider) payload.provider = provider;
  } else if (config.aiProvider === 'deepseek') {
    if (payload.max_tokens == null && payload.max_completion_tokens != null) {
      payload.max_tokens = payload.max_completion_tokens;
    }
    delete payload.max_completion_tokens;
    if (config.reasoningEffort) payload.reasoning_effort = config.reasoningEffort;
  }

  if (!IS_VENICE && config.minCompletionTokens > 0) {
    if ('max_completion_tokens' in payload) {
      payload.max_completion_tokens = Math.max(Number(payload.max_completion_tokens) || 0, config.minCompletionTokens);
    } else {
      payload.max_tokens = Math.max(Number(payload.max_tokens) || 0, config.minCompletionTokens);
    }
  }

  if (config.aiProvider === 'openrouter' && (config.reasoningEffort || config.reasoningMaxTokens || config.reasoningExclude)) {
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
    if (config.aiProvider === 'openrouter' && payload.reasoning && typeof payload.reasoning === 'object') {
      payload.reasoning = { ...payload.reasoning, exclude: true };
      if (!config.reasoningEffort && 'effort' in payload.reasoning) payload.reasoning.effort = 'minimal';
    }
  }

  if (IS_VENICE) {
    return venicePayload(payload, {
      effort: config.reasoningEffort,
      excludeReasoning: config.reasoningExclude,
      minCompletionTokens: config.minCompletionTokens,
      retry,
    });
  }
  return config.aiProvider === 'deepseek' ? deepSeekPayload(payload) : payload;
}

function upstreamHeaders() {
  const headers = {
    Authorization: `Bearer ${UPSTREAM_KEY}`,
    'Content-Type': 'application/json',
  };
  if (config.aiProvider === 'openrouter' && config.openRouterReferer) headers['HTTP-Referer'] = config.openRouterReferer;
  if (config.aiProvider === 'openrouter' && config.openRouterTitle) headers['X-Title'] = config.openRouterTitle;
  return headers;
}

export async function callUpstream(payload, signal) {
  return fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: upstreamHeaders(),
    body: JSON.stringify(payload),
    signal,
    ...(IS_VENICE ? { redirect: 'error' } : {}),
  });
}

export async function readUpstreamJson(response) {
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (IS_VENICE) throw veniceError(null, { status: response.ok ? 502 : response.status });
    const err = new Error(`${UPSTREAM_NAME} returned non-JSON response (${response.status})`);
    err.status = response.status || 502;
    err.details = text.slice(0, 2000);
    throw err;
  }
  if (IS_VENICE && (!response.ok || json?.error)) {
    throw veniceError(json, {
      status: response.ok ? undefined : response.status,
      retryAfter: response.headers?.get('retry-after'),
    });
  }
  if (!response.ok) {
    const err = new Error(json?.error?.message || `${UPSTREAM_NAME} HTTP ${response.status}`);
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

  if (config.aiProvider === 'deepseek') {
    delete payload.reasoning;
    payload.reasoning_effort = config.translatorReasoningEffort;
    return deepSeekPayload(payload);
  }
  if (IS_VENICE) {
    return venicePayload(payload, { effort: config.translatorReasoningEffort, excludeReasoning: true });
  }

  const providers = config.translatorProvider;
  // Do not inherit the roleplay model's global provider sort here:
  // the default translator model uses :nitro, which already means throughput sorting.
  const provider = buildProviderConfig(providers, config.allowFallbacks, { sort: '' });
  if (provider) payload.provider = provider;

  return payload;
}

export async function rewriteToSpanish(text, originalModel, signal) {
  const payload = translatorPayload(text, originalModel, false);
  const response = await callUpstream(payload, signal);
  const json = await readUpstreamJson(response);
  const rewritten = extractContent(json).trim();
  if (!rewritten) throw new Error('Translator returned an empty response');
  return { text: rewritten, model: payload.model };
}

export async function completeBuffered(input, signal, context = {}) {
  const started = Date.now();
  let attempts = 0;
  let json;
  let content = '';
  let reasoningChars = 0;
  let toolCalls = false;
  let generationMs = 0;

  while (attempts <= config.emptyResponseRetry) {
    const attemptNumber = attempts + 1;
    context.attempt = attemptNumber;
    context.attempts = attemptNumber;
    const generationStarted = Date.now();
    const payload = preparePayload(input, { stream: false, retry: attempts > 0 });
    let response;
    try {
      context.stage = 'upstream_connect';
      response = await callUpstream(payload, signal);
      context.stage = 'upstream_response';
      json = await readUpstreamJson(response);
    } catch (err) {
      context.stage = context.stage || 'upstream';
      context.onAttemptFailed?.(err, {
        attempt: attemptNumber,
        attempts: attemptNumber,
        stage: context.stage,
        retryable: false,
      });
      throw err;
    }
    generationMs += Date.now() - generationStarted;

    content = extractContent(json).trim();
    reasoningChars = reasoningSize(json);
    const calls = json?.choices?.[0]?.message?.tool_calls;
    toolCalls = IS_VENICE && Array.isArray(calls) && calls.length > 0;
    if (content || toolCalls) break;

    attempts += 1;
    const canRetry = attempts <= config.emptyResponseRetry;
    const emptyErr = new Error('Model returned no visible content');
    emptyErr.status = 200;
    emptyErr.details = { reasoning_chars: reasoningChars, attempt: attemptNumber };
    context.stage = 'generation';
    context.onAttemptFailed?.(emptyErr, {
      attempt: attemptNumber,
      attempts,
      stage: 'generation',
      retryable: canRetry,
      errorType: 'empty_response',
      errorCode: 'no_visible_content',
      upstreamStatus: response?.status || 200,
    });

    if (!canRetry) {
      const err = new Error('Model returned no visible content after retrying');
      err.status = 502;
      err.details = { reasoning_chars: reasoningChars, attempts };
      throw err;
    }
  }

  let rewritten = false;
  let rewriteMs = 0;
  let translatorModel = null;
  const sourceLanguage = detectOutputLanguage(content);
  const mode = config.outputMode;
  const shouldRewrite = !toolCalls &&
    (mode === 'strict' || ((mode === 'auto' || mode === 'smart') && shouldRewriteToSpanish(content)));

  if (shouldRewrite) {
    context.stage = 'rewrite';
    const rewriteStarted = Date.now();
    let result;
    try {
      result = await rewriteToSpanish(content, config.forceModel || input?.model, signal);
    } catch (err) {
      context.onAttemptFailed?.(err, {
        attempt: attempts + 1,
        attempts: attempts + 1,
        stage: 'rewrite',
        retryable: false,
      });
      throw err;
    }
    rewriteMs = Date.now() - rewriteStarted;
    content = result.text;
    translatorModel = result.model;
    rewritten = true;
  }

  const message = json.choices[0].message;
  if (content || !toolCalls) message.content = content;
  if (config.reasoningExclude) {
    if (IS_VENICE) stripVeniceReasoning(message);
    else {
      if (message.reasoning != null) delete message.reasoning;
      if (message.reasoning_content != null) delete message.reasoning_content;
      if (message.reasoning_details != null) delete message.reasoning_details;
    }
  }

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

function endVeniceSse(res, signal) {
  signal?.throwIfAborted();
  if (!res.writableEnded) res.end('data: [DONE]\n\n');
}

export async function writeWithBackpressure(res, value, signal) {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }
  if (res.destroyed || res.writableEnded) {
    const err = new Error('Client disconnected');
    err.name = 'ClientDisconnectError';
    err.code = 'client_disconnected';
    err.status = 499;
    throw err;
  }

  const ok = res.write(value);
  if (ok) return;

  await new Promise((resolve, reject) => {
    let cleanup;

    const onDrain = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      if (!res.writableEnded) {
        const err = new Error('Client disconnected');
        err.name = 'ClientDisconnectError';
        err.code = 'client_disconnected';
        err.status = 499;
        reject(err);
      } else {
        resolve();
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      cleanup();
      const reason = signal?.reason;
      if (reason instanceof Error) {
        reject(reason);
      } else {
        const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      }
    };

    cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (res.destroyed || res.writableEnded) {
      onClose();
    }
  });
}

export async function writeRawSseEvent(res, rawEvent, signal) {
  if (!rawEvent) return;
  await writeWithBackpressure(res, `${rawEvent}\n\n`, signal);
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
  const isErrorEvent = IS_VENICE && lines.some((line) => /^event:\s*error\s*$/.test(line));
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));

  if (!dataLines.length) return { kind: isErrorEvent ? 'error' : 'other', raw: rawEvent };

  const data = dataLines.join('\n');
  if (data.trim() === '[DONE]') return { kind: 'done', raw: rawEvent };

  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return { kind: isErrorEvent ? 'error' : (IS_VENICE ? 'invalid' : 'other'), raw: rawEvent };
  }
  if (IS_VENICE && (isErrorEvent || json?.error)) return { kind: 'error', json };

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
    toolCalls: Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0,
    finishReason: choice.finish_reason || null,
  };
}

async function* iterateCompletionEvents(body) {
  for await (const raw of iterateSseEvents(body)) {
    const parsed = parseSseEvent(raw);
    if (IS_VENICE) {
      if (parsed.kind === 'error') throw veniceError(parsed.json, { stream: true });
      if (parsed.kind === 'invalid') throw veniceError({ code: 'INVALID_SSE_EVENT' }, { stream: true });
      if (parsed.kind === 'done') return;
      if (config.reasoningExclude && Array.isArray(parsed.json?.choices)) {
        let changed = false;
        for (const choice of parsed.json.choices) {
          if (stripVeniceReasoning(choice?.delta)) changed = true;
        }
        if (changed) parsed.raw = `data: ${JSON.stringify(parsed.json)}`;
      }
    }
    yield parsed;
  }
  if (IS_VENICE) throw veniceError({ code: 'INCOMPLETE_STREAM' }, { stream: true });
}

export async function streamPassthrough(input, res, signal, context = {}) {
  if (IS_VENICE) return streamInspected(input, res, signal, context, false);
  const payload = preparePayload(input, { stream: true });
  context.attempt = 1;
  context.attempts = 1;
  let response;
  try {
    context.stage = 'upstream_connect';
    response = await callUpstream(payload, signal);
    context.stage = 'upstream_response';
    if (!response.ok) {
      const json = await readUpstreamJson(response); // throws
      return json;
    }
  } catch (err) {
    context.onAttemptFailed?.(err, {
      attempt: 1,
      attempts: 1,
      stage: context.stage || 'upstream',
      retryable: false,
    });
    throw err;
  }

  startSseResponse(res);
  context.stage = 'stream';

  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      await writeWithBackpressure(res, buffer, signal);
    }
  } catch (err) {
    if (err?.name !== 'ClientDisconnectError' && !signal?.aborted) {
      context.onAttemptFailed?.(err, {
        attempt: 1,
        attempts: 1,
        stage: 'stream',
        retryable: false,
      });
    }
    throw err;
  }
  if (!res.writableEnded) res.end();
  return { bytes, attempts: 1, stream_strategy: 'raw_passthrough' };
}

function completionBase(model) {
  return {
    id: `chatcmpl-proxy-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'proxy',
  };
}

async function writeSyntheticChunk(res, base, delta, finishReason = null, signal) {
  const event = {
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  await writeWithBackpressure(res, `data: ${JSON.stringify(event)}\n\n`, signal);
}

async function streamRewriteToSpanish(text, originalModel, res, signal) {
  const payload = translatorPayload(text, originalModel, true);
  const rewriteStarted = Date.now();
  const response = await callUpstream(payload, signal);
  if (!response.ok) {
    await readUpstreamJson(response); // throws
  }

  const base = completionBase(payload.model);
  let startedVisibleOutput = false;
  let translatedChars = 0;
  let hasVisibleText = false;
  let finishReason = 'stop';

  for await (const parsed of iterateCompletionEvents(response.body)) {
    if (parsed.kind !== 'chunk') continue;

    if (parsed.finishReason) finishReason = parsed.finishReason;
    if (!parsed.content) continue;

    if (!startedVisibleOutput) {
      await writeSyntheticChunk(res, base, { role: 'assistant' }, null, signal);
      startedVisibleOutput = true;
    }

    translatedChars += parsed.content.length;
    if (parsed.content.trim()) hasVisibleText = true;
    await writeSyntheticChunk(res, base, { content: parsed.content }, null, signal);
  }

  if (!startedVisibleOutput || (IS_VENICE && !hasVisibleText)) {
    throw new Error('Translator returned an empty streaming response');
  }

  await writeSyntheticChunk(res, base, {}, finishReason, signal);
  if (IS_VENICE) endVeniceSse(res, signal);
  else await writeWithBackpressure(res, 'data: [DONE]\n\n', signal);

  return {
    rewrite_ms: Date.now() - rewriteStarted,
    translated_chars: translatedChars,
    translator_model: payload.model,
  };
}

export function streamSmart(input, res, signal, context = {}) {
  return streamInspected(input, res, signal, context, true);
}

async function streamInspected(input, res, signal, context, detectLanguage) {
  const totalStarted = Date.now();
  let attempts = 0;
  let bufferingNoticeSent = false;

  while (attempts <= config.emptyResponseRetry) {
    const attemptNumber = attempts + 1;
    context.attempt = attemptNumber;
    context.attempts = attemptNumber;
    const generationStarted = Date.now();
    const payload = preparePayload(input, { stream: true, retry: attempts > 0 });
    let response;
    try {
      context.stage = 'upstream_connect';
      response = await callUpstream(payload, signal);
      context.stage = 'upstream_response';
      if (!response.ok) {
        await readUpstreamJson(response); // throws
      }
    } catch (err) {
      context.stage = context.stage || 'upstream';
      context.onAttemptFailed?.(err, {
        attempt: attemptNumber,
        attempts: attemptNumber,
        stage: context.stage,
        retryable: false,
      });
      throw err;
    }

    // Only commit HTTP 200/SSE to Janitor after the upstream accepted the request.
    startSseResponse(res);
    if (detectLanguage && !bufferingNoticeSent) {
      await writeWithBackpressure(res, ': proxy-smart-buffering\n\n', signal);
      bufferingNoticeSent = true;
    }

    let bufferedEvents = [];
    let content = '';
    let reasoningChars = 0;
    let toolCalls = false;
    let decision = 'pending';
    let languageDetected = 'unknown';
    let decisionMs = 0;
    let passThroughStarted = false;

    context.stage = 'stream';
    try {
      for await (const parsed of iterateCompletionEvents(response.body)) {
        if (!detectLanguage && parsed.kind === 'other') {
          await writeRawSseEvent(res, parsed.raw, signal);
          continue;
        }
        if (parsed.kind === 'chunk') {
          content += parsed.content || '';
          reasoningChars += parsed.reasoningChars || 0;
          if (IS_VENICE && parsed.toolCalls) toolCalls = true;
        }

        if (decision === 'pending') {
          bufferedEvents.push(parsed.raw);

          if (toolCalls || (!detectLanguage && content.trim())) {
            decision = 'pass';
            decisionMs = Date.now() - generationStarted;
            for (const event of bufferedEvents) await writeRawSseEvent(res, event, signal);
            bufferedEvents = [];
            passThroughStarted = true;
          } else if (detectLanguage && !(IS_VENICE && payload.tools?.length) && content.length >= config.smartDetectChars) {
            languageDetected = detectOutputLanguage(content);

            if (languageDetected === 'en') {
              decision = 'rewrite';
              decisionMs = Date.now() - generationStarted;
              bufferedEvents = [];
            } else if (languageDetected === 'es') {
              decision = 'pass';
              decisionMs = Date.now() - generationStarted;
              for (const event of bufferedEvents) await writeRawSseEvent(res, event, signal);
              bufferedEvents = [];
              passThroughStarted = true;
            } else if (content.length >= config.smartMaxDetectChars) {
              decision = shouldRewriteToSpanish(content) ? 'rewrite' : 'pass';
              decisionMs = Date.now() - generationStarted;
              if (decision === 'pass') {
                for (const event of bufferedEvents) await writeRawSseEvent(res, event, signal);
                passThroughStarted = true;
              }
              bufferedEvents = [];
            }
          }
        } else if (decision === 'pass') {
          await writeRawSseEvent(res, parsed.raw, signal);
        }
        // decision === 'rewrite': continue consuming source silently.
      }
    } catch (err) {
      if (err?.name !== 'ClientDisconnectError' && !signal?.aborted) {
        context.onAttemptFailed?.(err, {
          attempt: attemptNumber,
          attempts: attemptNumber,
          stage: 'stream',
          retryable: false,
        });
      }
      throw err;
    }

    const generationMs = Date.now() - generationStarted;
    const trimmedContent = content.trim();

    if (!trimmedContent && !toolCalls) {
      attempts += 1;
      const canRetry = attempts <= config.emptyResponseRetry;
      const emptyErr = new Error('Model returned no visible content');
      emptyErr.status = 200;
      emptyErr.details = { reasoning_chars: reasoningChars, attempt: attemptNumber };
      context.stage = 'stream';
      context.onAttemptFailed?.(emptyErr, {
        attempt: attemptNumber,
        attempts,
        stage: 'stream',
        retryable: canRetry,
        errorType: 'empty_response',
        errorCode: 'no_visible_content',
        upstreamStatus: response?.status || 200,
      });

      if (canRetry) {
        await writeWithBackpressure(res, ': proxy-retrying-empty-response\n\n', signal);
        continue;
      }

      const err = new Error('Model returned no visible content after retrying');
      err.status = 502;
      err.details = { reasoning_chars: reasoningChars, attempts };
      throw err;
    }

    if (decision === 'pending') {
      languageDetected = detectOutputLanguage(trimmedContent);
      decision = shouldRewriteToSpanish(trimmedContent) ? 'rewrite' : 'pass';
      decisionMs = generationMs;

      if (decision === 'pass') {
        for (const event of bufferedEvents) await writeRawSseEvent(res, event, signal);
        passThroughStarted = true;
      }
      bufferedEvents = [];
    }

    if (decision === 'pass') {
      if (IS_VENICE) endVeniceSse(res, signal);
      else if (!res.writableEnded) res.end();
      return {
        elapsed_ms: Date.now() - totalStarted,
        generation_ms: generationMs,
        rewrite_ms: 0,
        decision_ms: decisionMs,
        attempts: attempts + 1,
        rewritten: false,
        language_detected: languageDetected,
        stream_strategy: detectLanguage
          ? (passThroughStarted ? 'smart_passthrough' : 'smart_buffered_passthrough')
          : 'sse_passthrough',
        translator_model: null,
        visible_chars: trimmedContent.length,
        reasoning_chars: reasoningChars,
      };
    }

    context.stage = 'rewrite';
    let rewrite;
    try {
      rewrite = await streamRewriteToSpanish(
        trimmedContent,
        config.forceModel || input?.model,
        res,
        signal,
      );
    } catch (err) {
      if (err?.name !== 'ClientDisconnectError' && !signal?.aborted) {
        context.onAttemptFailed?.(err, {
          attempt: attemptNumber,
          attempts: attemptNumber,
          stage: 'rewrite',
          retryable: false,
        });
      }
      throw err;
    }
    if (!res.writableEnded) res.end();

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

export async function sendBufferedAsSse(res, json, signal) {
  const message = json?.choices?.[0]?.message || {};
  const id = json?.id || `chatcmpl-proxy-${crypto.randomUUID()}`;
  const model = json?.model || 'proxy';
  const created = json?.created || Math.floor(Date.now() / 1000);
  const content = typeof message.content === 'string' ? message.content : '';

  startSseResponse(res);

  const base = { id, object: 'chat.completion.chunk', created, model };
  await writeWithBackpressure(res, `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`, signal);
  if (IS_VENICE && !config.reasoningExclude) {
    const reasoning = veniceReasoningDelta(message);
    if (Object.keys(reasoning).length) await writeSyntheticChunk(res, base, reasoning, null, signal);
  }
  for (const part of splitForSse(content)) {
    await writeWithBackpressure(res, `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`, signal);
  }
  if (IS_VENICE && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const toolCalls = message.tool_calls.map((call, index) => ({ ...call, index }));
    await writeSyntheticChunk(res, base, { tool_calls: toolCalls }, null, signal);
  }
  const finishReason = json?.choices?.[0]?.finish_reason || 'stop';
  await writeWithBackpressure(res, `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`, signal);
  if (IS_VENICE && json?.usage) {
    await writeWithBackpressure(res, `data: ${JSON.stringify({ ...base, choices: [], usage: json.usage })}\n\n`, signal);
  }
  if (IS_VENICE) {
    endVeniceSse(res, signal);
  } else {
    await writeWithBackpressure(res, 'data: [DONE]\n\n', signal);
    if (!res.writableEnded) res.end();
  }
}
