export const VENICE_MODEL = 'deepseek-v4-1-flash-1017-uncensored';
export const VENICE_TRANSLATOR_MODEL = 'qwen3-5-35b-a3b';
export const VENICE_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const VENICE_FIELDS = new Set([
  'model', 'messages', 'stream', 'temperature', 'top_p', 'top_k', 'min_p',
  'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'stop', 'seed',
  'response_format', 'tools', 'tool_choice', 'parallel_tool_calls',
]);
const VENICE_OPTIONS = ['include_venice_system_prompt', 'disable_thinking', 'strip_thinking_response'];
const REASONING_FIELDS = ['reasoning', 'reasoning_content', 'reasoning_details', 'thought_signature'];

function baseModel(model) {
  // Venice feature suffixes can activate search, scraping, and other services.
  return typeof model === 'string' ? model.split(':', 1)[0] : model;
}

export function veniceReasoningEfforts(model) {
  const id = baseModel(model);
  if (id === VENICE_MODEL) return ['none', 'low', 'high', 'max'];
  if (id === VENICE_TRANSLATOR_MODEL) return ['none', 'low', 'medium', 'high'];
  return VENICE_REASONING_EFFORTS;
}

export function venicePayload(payload, { effort, excludeReasoning, minCompletionTokens = 0, retry = false } = {}) {
  const result = Object.fromEntries(Object.entries(payload).filter(([key]) => VENICE_FIELDS.has(key)));
  result.model = baseModel(result.model);

  const maxTokens = payload.max_completion_tokens ?? (payload.max_tokens > 0 ? payload.max_tokens : undefined);
  if (minCompletionTokens > 0) {
    result.max_completion_tokens = Math.max(Number(maxTokens) || 0, minCompletionTokens);
  } else if (maxTokens !== undefined) {
    result.max_completion_tokens = maxTokens;
  }

  const includeUsage = payload.stream_options?.include_usage;
  if (result.stream && typeof includeUsage === 'boolean') result.stream_options = { include_usage: includeUsage };

  const options = { include_venice_system_prompt: false };
  for (const key of VENICE_OPTIONS) {
    const value = payload.venice_parameters?.[key];
    if (typeof value === 'boolean') options[key] = value;
  }
  if (excludeReasoning) options.strip_thinking_response = true;
  result.venice_parameters = options;

  const allowed = veniceReasoningEfforts(result.model);
  const requestedEffort = [effort, payload.reasoning_effort, payload.reasoning?.effort]
    .find((value) => allowed.includes(value));
  if (requestedEffort) {
    result.reasoning_effort = requestedEffort;
    // An explicit effort takes precedence over client thinking toggles.
    delete options.disable_thinking;
  } else if (typeof payload.reasoning?.enabled === 'boolean') {
    result.reasoning = { enabled: payload.reasoning.enabled };
    delete options.disable_thinking;
  } else if (retry && result.model === VENICE_MODEL && options.disable_thinking === undefined) {
    result.reasoning_effort = 'none';
  }
  return result;
}

export function stripVeniceReasoning(message) {
  let changed = false;
  for (const field of REASONING_FIELDS) {
    if (message && Object.hasOwn(message, field)) {
      delete message[field];
      changed = true;
    }
  }
  return changed;
}

export function veniceReasoningDelta(message) {
  return Object.fromEntries(REASONING_FIELDS.filter((field) => message[field] != null)
    .map((field) => [field, message[field]]));
}

const ERROR_STATUS = {
  AUTHENTICATION_FAILED: 401,
  AUTHENTICATION_FAILED_INACTIVE_KEY: 401,
  PRO_ONLY_MODEL: 401,
  AUTHENTICATION_ERROR: 401,
  INSUFFICIENT_BALANCE: 402,
  INSUFFICIENT_QUOTA: 402,
  API_KEY_DIEM_SPEND_LIMIT_EXCEEDED: 402,
  API_KEY_USD_SPEND_LIMIT_EXCEEDED: 402,
  UNAUTHORIZED: 403,
  API_ACCESS_DISABLED: 403,
  INVALID_REQUEST: 400,
  INVALID_REQUEST_ERROR: 400,
  INVALID_MODEL: 400,
  TOO_MANY_TOKENS: 400,
  CONTEXT_LENGTH_EXCEEDED: 400,
  MODEL_NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMIT_EXCEEDED: 429,
  RATE_LIMIT_ERROR: 429,
  MODEL_OVERLOADED: 429,
  INFERENCE_FAILED: 500,
  INVALID_SSE_EVENT: 502,
  INCOMPLETE_STREAM: 502,
  MODEL_OFFLINE: 503,
  MODEL_AT_CAPACITY: 503,
  REQUEST_TIMEOUT: 504,
};

const CODE_MESSAGE = {
  MODEL_OVERLOADED: 'The Venice model is overloaded',
  INVALID_SSE_EVENT: 'Venice returned an invalid SSE event',
  INCOMPLETE_STREAM: 'Venice stream ended before [DONE]',
};

const ERROR_MESSAGE = {
  400: 'Venice rejected the request parameters',
  401: 'Venice authentication failed',
  402: 'Venice balance or API key spending limit was reached',
  403: 'Venice API access is forbidden',
  404: 'The Venice model was not found',
  413: 'Venice rejected the request size',
  429: 'Venice rate limit exceeded',
  503: 'The Venice model is unavailable or at capacity',
  504: 'Venice request timed out',
};

export function veniceError(json, { status, retryAfter, stream = false } = {}) {
  const upstream = json?.error;
  const code = [upstream?.code, json?.code, upstream?.type]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toUpperCase())
    .find((value) => Object.hasOwn(ERROR_STATUS, value));
  const reportedStatus = upstream?.status ?? json?.status;
  const errorStatus = status ?? ERROR_STATUS[code] ??
    (Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599 ? reportedStatus : 502);
  const message = CODE_MESSAGE[code] || ERROR_MESSAGE[errorStatus] || `Venice request failed (${errorStatus})`;
  const err = new Error(message);
  err.status = errorStatus;
  err.type = stream ? 'upstream_stream_error' : 'upstream_http_error';
  err.details = { status: errorStatus };
  if (code) {
    err.code = code;
    err.details.code = code;
  }
  const retry = upstream?.retry_after ?? json?.retry_after ?? retryAfter;
  if ((typeof retry === 'number' || typeof retry === 'string' && /^\d+$/.test(retry)) &&
    Number.isFinite(Number(retry)) && Number(retry) >= 0) {
    err.details.retry_after = Number(retry);
  }
  return err;
}
