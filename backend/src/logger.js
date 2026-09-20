import { config } from './config.js';

const listeners = new Set();

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearLogListeners() {
  listeners.clear();
}

const REDACTED_KEYS = /^(authorization|proxy-authorization|bearer|api[_-]?key|token|secret|password|cookie|set-cookie)$/i;
const SENSITIVE_VALUE_REGEX = /(Bearer\s+)[A-Za-z0-9_\-\.]+|sk-[A-Za-z0-9_\-\.]+/gi;

export function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (depth > 6) return '[truncated_depth]';

  if (typeof value === 'string') {
    let clean = value.replace(SENSITIVE_VALUE_REGEX, '$1[REDACTED]');
    if (clean.length > 1000) {
      clean = `${clean.slice(0, 1000)}... [truncated ${clean.length - 1000} chars]`;
    }
    return clean;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1, seen));
    }

    const cleanObj = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACTED_KEYS.test(k)) {
        cleanObj[k] = '[REDACTED]';
      } else if (k === 'raw' && depth > 0) {
        cleanObj[k] = '[REDACTED]';
      } else {
        cleanObj[k] = sanitizeValue(v, depth + 1, seen);
      }
    }
    return cleanObj;
  }

  return String(value);
}

export function classifyError(error, {
  clientDisconnected = false,
  timedOut = false,
  proxyAborted = false,
  stage = 'internal',
} = {}) {
  // 1. Client closed connection
  if (clientDisconnected || error?.name === 'ClientDisconnectError' || error?.message === 'Client disconnected') {
    return {
      errorType: 'client_closed_connection',
      errorCode: 'client_disconnected',
      upstreamStatus: null,
      errorMessage: 'Client disconnected',
      clientDisconnected: true,
    };
  }

  // 2. Timeout
  if (timedOut || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.message === 'Upstream timeout' || error?.message?.toLowerCase().includes('timed out')) {
    return {
      errorType: 'timeout',
      errorCode: error?.code || 'upstream_timeout',
      upstreamStatus: error?.status || null,
      errorMessage: 'Upstream request timed out',
      clientDisconnected: false,
    };
  }

  // 3. Proxy server aborted
  if (proxyAborted || error?.name === 'ProxyAbortError' || error?.message === 'Proxy aborted') {
    return {
      errorType: 'proxy_aborted',
      errorCode: 'proxy_aborted',
      upstreamStatus: null,
      errorMessage: 'Proxy server aborted request',
      clientDisconnected: false,
    };
  }

  // 4. Authentication error
  if (error?.type === 'authentication_error' || error?.status === 401 || stage === 'auth') {
    return {
      errorType: 'authentication_error',
      errorCode: 401,
      upstreamStatus: null,
      errorMessage: error?.message || 'Invalid proxy API key',
      clientDisconnected: false,
    };
  }

  // 5. Payload too large
  if (error?.status === 413 || error?.message?.includes('exceeds BODY_LIMIT')) {
    return {
      errorType: 'payload_too_large',
      errorCode: 413,
      upstreamStatus: null,
      errorMessage: error?.message || 'Request body too large',
      clientDisconnected: false,
    };
  }

  // 6. Invalid request error
  if (error?.type === 'invalid_request_error' || (stage === 'validation' && error?.status === 400)) {
    return {
      errorType: 'invalid_request_error',
      errorCode: error?.status || 400,
      upstreamStatus: null,
      errorMessage: error?.message || 'Invalid request',
      clientDisconnected: false,
    };
  }

  // 7. Parsing error
  if (error?.type === 'parsing_error' || error?.message?.includes('not valid JSON') || error?.message?.includes('non-JSON response') || error instanceof SyntaxError) {
    return {
      errorType: 'parsing_error',
      errorCode: error?.code || 'json_parse_error',
      upstreamStatus: error?.status || null,
      errorMessage: error?.message || 'JSON parsing error',
      clientDisconnected: false,
    };
  }

  // 8. Empty response error
  if (error?.message?.includes('no visible content')) {
    return {
      errorType: 'empty_response',
      errorCode: 'no_visible_content',
      upstreamStatus: error?.status || 200,
      errorMessage: error?.message || 'Model returned no visible content',
      clientDisconnected: false,
    };
  }

  // 9. Upstream HTTP error
  if (error?.status && error.status >= 400) {
    return {
      errorType: 'upstream_http_error',
      errorCode: `HTTP_${error.status}`,
      upstreamStatus: error.status,
      errorMessage: error.message || `Upstream HTTP ${error.status}`,
      clientDisconnected: false,
    };
  }

  // 10. Upstream connection closed / network error
  const msg = String(error?.message || '').toLowerCase();
  const causeCode = error?.cause?.code || error?.cause?.name;
  const code = error?.code || causeCode;
  const isNetwork = (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    msg.includes('premature close') ||
    msg.includes('socket hang up') ||
    msg.includes('other side closed')
  );

  if (isNetwork) {
    return {
      errorType: 'upstream_closed_connection',
      errorCode: code || 'upstream_connection_closed',
      upstreamStatus: null,
      errorMessage: error?.message || 'Upstream connection closed unexpectedly',
      clientDisconnected: false,
    };
  }

  // 11. Internal error fallback
  return {
    errorType: 'internal_error',
    errorCode: error?.name || 'internal_error',
    upstreamStatus: null,
    errorMessage: error?.message || 'Internal proxy error',
    clientDisconnected: false,
  };
}

function emitLog(record) {
  try {
    const line = JSON.stringify(record);
    if (record.level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch {
    console.error('{"level":"error","event":"log_serialization_error","error_message":"Failed to serialize log"}');
  }

  for (const listener of listeners) {
    try {
      listener(record);
    } catch {}
  }
}

export function logRequestStarted({
  requestId,
  route = 'chat',
  stream = false,
  model = null,
  provider = null,
  outputMode = config.outputMode,
  messages = 0,
}) {
  const record = {
    level: 'info',
    event: 'request_started',
    request_id: requestId,
    route,
    stream: Boolean(stream),
    model: config.forceModel || model || null,
    provider: provider || config.providers.join(',') || 'auto',
    output_mode: outputMode,
    messages: Number.isFinite(messages) ? messages : 0,
    elapsed_ms: 0,
  };
  emitLog(record);
}

export function logAttemptFailed({
  requestId,
  route = 'chat',
  stream = false,
  model = null,
  provider = null,
  outputMode = config.outputMode,
  attempt = 1,
  attempts = 1,
  stage = 'upstream',
  elapsedMs = 0,
  error = null,
  errorType = null,
  errorCode = null,
  upstreamStatus = undefined,
  errorMessage = null,
  clientDisconnected = false,
  timedOut = false,
  retryable = false,
  details = null,
}) {
  const classified = classifyError(error, {
    clientDisconnected,
    timedOut,
    stage,
  });

  const record = {
    level: retryable ? 'warn' : 'error',
    event: 'upstream_attempt_failed',
    request_id: requestId,
    route,
    stream: Boolean(stream),
    model: config.forceModel || model || null,
    provider: provider || config.providers.join(',') || 'auto',
    output_mode: outputMode,
    attempt,
    attempts,
    stage,
    elapsed_ms: elapsedMs,
    error_type: errorType || classified.errorType,
    error_code: errorCode || classified.errorCode,
    upstream_status: upstreamStatus !== undefined ? upstreamStatus : classified.upstreamStatus,
    error_message: sanitizeValue(errorMessage || error?.message || classified.errorMessage),
    client_disconnected: clientDisconnected || classified.clientDisconnected,
    retryable: Boolean(retryable),
    final: !retryable,
    ...(details || error?.details ? { details: sanitizeValue(details || error?.details) } : {}),
  };
  emitLog(record);
}

export function logRequestCompleted({
  requestId,
  route = 'chat',
  stream = false,
  model = null,
  provider = null,
  outputMode = config.outputMode,
  elapsedMs = 0,
  generationMs = 0,
  rewriteMs = 0,
  decisionMs = 0,
  attempts = 1,
  rewritten = false,
  languageDetected = 'unknown',
  streamStrategy = null,
  translatorModel = null,
  visibleChars = 0,
  sourceChars = undefined,
  reasoningChars = 0,
  messages = 0,
  promptPreview = undefined,
}) {
  const record = {
    level: 'info',
    event: 'request_completed',
    request_id: requestId,
    route,
    stream: Boolean(stream),
    model: config.forceModel || model || null,
    provider: provider || config.providers.join(',') || 'auto',
    output_mode: outputMode,
    elapsed_ms: elapsedMs,
    generation_ms: generationMs,
    rewrite_ms: rewriteMs,
    decision_ms: decisionMs,
    attempt: attempts,
    attempts,
    rewritten: Boolean(rewritten),
    language_detected: languageDetected,
    stream_strategy: streamStrategy,
    translator_model: translatorModel,
    visible_chars: visibleChars,
    ...(sourceChars !== undefined ? { source_chars: sourceChars } : {}),
    reasoning_chars: reasoningChars,
    messages: Number.isFinite(messages) ? messages : 0,
    ...(promptPreview && config.logPromptContent ? { prompt_preview: sanitizeValue(promptPreview) } : {}),
  };
  emitLog(record);
}

export function logRequestFailed({
  requestId,
  route = 'chat',
  stream = false,
  model = null,
  provider = null,
  outputMode = config.outputMode,
  attempt = null,
  attempts = 0,
  stage = 'internal',
  elapsedMs = 0,
  error = null,
  errorType = null,
  errorCode = null,
  upstreamStatus = undefined,
  errorMessage = null,
  clientDisconnected = false,
  timedOut = false,
  proxyAborted = false,
  clientStatus = 502,
  details = null,
}) {
  const classified = classifyError(error, {
    clientDisconnected,
    timedOut,
    proxyAborted,
    stage,
  });

  const finalErrorMessage = sanitizeValue(errorMessage || error?.message || classified.errorMessage);

  const record = {
    level: 'error',
    event: 'request_failed',
    request_id: requestId,
    route,
    stream: Boolean(stream),
    model: config.forceModel || model || null,
    provider: provider || config.providers.join(',') || 'auto',
    output_mode: outputMode,
    attempt: attempt != null ? attempt : (attempts > 0 ? attempts : null),
    attempts,
    stage,
    elapsed_ms: elapsedMs,
    error_type: errorType || classified.errorType,
    error_code: errorCode || classified.errorCode,
    upstream_status: upstreamStatus !== undefined ? upstreamStatus : classified.upstreamStatus,
    error_message: finalErrorMessage,
    client_disconnected: clientDisconnected || classified.clientDisconnected,
    retryable: false,
    final: true,
    status: clientStatus,
    message: finalErrorMessage,
    ...(details || error?.details ? { details: sanitizeValue(details || error?.details) } : {}),
  };
  emitLog(record);
}
