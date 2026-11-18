import { VENICE_REASONING_EFFORTS, VENICE_TRANSLATOR_MODEL, veniceReasoningEfforts } from './venice.js';

function asBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function csv(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const aiProvider = String(process.env.AI_PROVIDER || 'openrouter').trim().toLowerCase();
if (!['openrouter', 'deepseek', 'venice'].includes(aiProvider)) {
  throw new Error('AI_PROVIDER must be one of: openrouter, deepseek, venice');
}

const defaultTranslator = {
  openrouter: 'openai/gpt-oss-20b:nitro',
  deepseek: 'deepseek-flash',
  venice: VENICE_TRANSLATOR_MODEL,
};

const outputMode = String(process.env.OUTPUT_MODE || 'smart').toLowerCase();
if (!['prompt', 'smart', 'auto', 'strict'].includes(outputMode)) {
  throw new Error('OUTPUT_MODE must be one of: prompt, smart, auto, strict');
}

const smartDetectChars = asInt(process.env.SMART_DETECT_CHARS, 500, 100, 4000);
const smartMaxDetectChars = asInt(process.env.SMART_MAX_DETECT_CHARS, 1000, smartDetectChars, 8000);

export const config = Object.freeze({
  port: asInt(process.env.PORT, 3000, 1, 65535),
  bodyLimit: process.env.BODY_LIMIT || '12mb',
  aiProvider,
  deepSeekApiKey: process.env.DEEPSEEK_API_KEY || '',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  veniceApiKey: process.env.VENICE_API_KEY?.trim() || '',
  proxyApiKey: process.env.PROXY_API_KEY || '',
  forceModel: process.env.FORCE_MODEL?.trim() || '',
  providers: csv(process.env.OPENROUTER_PROVIDER),
  allowFallbacks: asBool(process.env.ALLOW_PROVIDER_FALLBACKS, false),
  providerSort: process.env.PROVIDER_SORT?.trim() || '',
  dataCollection: process.env.DATA_COLLECTION?.trim() || 'deny',
  requireParameters: asBool(process.env.REQUIRE_PARAMETERS, false),
  openRouterReferer: process.env.OPENROUTER_HTTP_REFERER?.trim() || '',
  openRouterTitle: process.env.OPENROUTER_X_TITLE?.trim() || 'Janitor OpenRouter Proxy',
  corsOrigins: csv(process.env.CORS_ORIGIN || '*'),

  outputMode,
  smartDetectChars,
  smartMaxDetectChars,

  translatorModel: process.env.TRANSLATOR_MODEL?.trim() || defaultTranslator[aiProvider],
  translatorProvider: csv(process.env.TRANSLATOR_PROVIDER),
  translatorReasoningEffort: process.env.TRANSLATOR_REASONING_EFFORT?.trim() || (aiProvider === 'openrouter' ? 'low' : 'none'),

  emptyResponseRetry: asInt(process.env.EMPTY_RESPONSE_RETRY, 1, 0, 2),
  minCompletionTokens: asInt(process.env.MIN_COMPLETION_TOKENS, 0, 0, 65536),
  reasoningEffort: process.env.REASONING_EFFORT?.trim() || '',
  reasoningMaxTokens: asInt(process.env.REASONING_MAX_TOKENS, 0, 0, 131072),
  reasoningExclude: asBool(process.env.REASONING_EXCLUDE, true),
  requestTimeoutMs: asInt(process.env.REQUEST_TIMEOUT_MS, 120000, 1000, 600000),
  logLevel: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
  logPromptContent: asBool(process.env.LOG_PROMPT_CONTENT, false),
  languagePolicyEnabled: asBool(process.env.LANGUAGE_POLICY_ENABLED, true),
});

export function assertConfig() {
  const missing = [];
  if (config.aiProvider === 'deepseek') {
    if (!config.deepSeekApiKey) missing.push('DEEPSEEK_API_KEY');
  } else if (config.aiProvider === 'venice') {
    if (!config.veniceApiKey) missing.push('VENICE_API_KEY');
  } else if (!config.openRouterApiKey) missing.push('OPENROUTER_API_KEY');
  if (!config.proxyApiKey) missing.push('PROXY_API_KEY');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (config.proxyApiKey.length < 16) {
    console.warn('[config] PROXY_API_KEY is short. Use a random value of at least 32 characters.');
  }

  if (config.aiProvider === 'openrouter' && config.providerSort && !['price', 'throughput', 'latency'].includes(config.providerSort)) {
    throw new Error('PROVIDER_SORT must be empty, price, throughput, or latency');
  }

  if (config.aiProvider === 'openrouter' && config.dataCollection && !['allow', 'deny'].includes(config.dataCollection)) {
    throw new Error('DATA_COLLECTION must be allow or deny');
  }

  const efforts = config.aiProvider === 'deepseek'
    ? ['none', 'low', 'high', 'max', 'minimal', 'medium', 'xhigh']
    : config.aiProvider === 'venice'
      ? veniceReasoningEfforts(config.translatorModel)
      : ['minimal', 'low', 'medium', 'high'];
  if (config.translatorReasoningEffort && !efforts.includes(config.translatorReasoningEffort)) {
    throw new Error(`TRANSLATOR_REASONING_EFFORT must be one of: ${efforts.join(', ')}`);
  }
  if (config.aiProvider === 'deepseek' && config.reasoningEffort && !efforts.includes(config.reasoningEffort)) {
    throw new Error(`REASONING_EFFORT for DeepSeek must be one of: ${efforts.join(', ')}`);
  }
  if (config.aiProvider === 'venice' && config.reasoningEffort) {
    const generationEfforts = config.forceModel ? veniceReasoningEfforts(config.forceModel) : VENICE_REASONING_EFFORTS;
    if (!generationEfforts.includes(config.reasoningEffort)) {
      throw new Error(`REASONING_EFFORT for Venice must be one of: ${generationEfforts.join(', ')}`);
    }
  }
}
