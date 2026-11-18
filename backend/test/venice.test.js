import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { VENICE_MODEL, VENICE_TRANSLATOR_MODEL, venicePayload } from '../src/venice.js';

const apiKey = 'venice-fixture-secret-without-bearer-prefix';
const proxyKey = 'janitor-fixture-key-32-characters';
const env = {
  PATH: process.env.PATH,
  AI_PROVIDER: 'venice',
  VENICE_API_KEY: apiKey,
  PROXY_API_KEY: proxyKey,
  FORCE_MODEL: VENICE_MODEL,
  EMPTY_RESPONSE_RETRY: '1',
  LANGUAGE_POLICY_ENABLED: 'true',
  REASONING_EXCLUDE: 'true',
  LOG_PROMPT_CONTENT: 'false',
  OPENROUTER_PROVIDER: 'legacy-route',
  OPENROUTER_HTTP_REFERER: 'https://example.test',
  OPENROUTER_X_TITLE: 'Legacy title',
  TRANSLATOR_PROVIDER: 'legacy-translator',
  OUTPUT_MODE: 'prompt',
  CORS_ORIGIN: 'https://janitor.example',
  REQUEST_TIMEOUT_MS: '1000',
};
Object.assign(process.env, env);
for (const key of ['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'TRANSLATOR_MODEL', 'TRANSLATOR_REASONING_EFFORT', 'REASONING_EFFORT', 'MIN_COMPLETION_TOKENS']) {
  delete process.env[key];
}

const { config, assertConfig } = await import('../src/config.js');
const { injectLanguagePolicy } = await import('../src/language.js');
const { onLog } = await import('../src/logger.js');
const { preparePayload, rewriteToSpanish, streamPassthrough, streamSmart } = await import('../src/proxy.js');
const { server } = await import('../src/server.js');

const messages = [
  { role: 'system', content: 'Keep the established roleplay format.' },
  { role: 'user', content: 'Private opening line' },
  { role: 'assistant', content: '—Hola.' },
  { role: 'user', content: [{ type: 'text', text: 'Sigue la escena.' }] },
];
const input = { model: 'openrouter/old-model', messages };
const spanish = '*Ella lo mira en silencio.*\n\n—¿Quieres venir conmigo?';
const english = '*She looks at him in silence.*\n\n"Do you want to come with me?"';
const secretError = `Echo of ${apiKey} and Private opening line`;
const usage = { prompt_tokens: 80, completion_tokens: 32, total_tokens: 112 };
const done = 'data: [DONE]\n\n';
const event = (json) => `data: ${JSON.stringify(json)}\n\n`;
const delta = (value, finishReason = null) => event({ choices: [{ index: 0, delta: value, finish_reason: finishReason }] });
const usageEvent = event({ choices: [], usage });
const flow = (text) => delta({ content: text }) + delta({}, 'stop') + usageEvent + done;

function completion(content, fields = {}, finishReason = 'stop') {
  return Response.json({
    id: 'test-venice',
    model: VENICE_MODEL,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content, ...fields }, finish_reason: finishReason }],
    usage,
  });
}

function stream(text) {
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

function mockVenice(t, respond) {
  return t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.venice.ai/api/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
    const payload = JSON.parse(options.body);
    assert.doesNotMatch(options.body, new RegExp(apiKey));
    return respond(payload, options.signal);
  });
}

function request(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port: server.address().port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { Authorization: `Bearer ${proxyKey}`, 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function sseOutput(text) {
  return text.split('\n\n').filter((value) => value.startsWith('data: ')).map((line) => {
    const data = line.slice(6);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

function runWithConfig(overrides, code = "const { assertConfig } = await import('./src/config.js'); assertConfig();") {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url),
    env: { ...env, ...overrides },
    encoding: 'utf8',
  });
}

test.before(async () => {
  server.listen(0);
  await once(server, 'listening');
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('validates Venice credentials and model-specific effort, independently of other providers', () => {
  assertConfig();
  assert.equal(config.translatorModel, VENICE_TRANSLATOR_MODEL);
  for (const [overrides, expected] of [
    [{ VENICE_API_KEY: '   ' }, /VENICE_API_KEY/],
    [{ PROXY_API_KEY: '' }, /PROXY_API_KEY/],
    [{ REASONING_EFFORT: 'medium' }, /REASONING_EFFORT for Venice/],
    [{ TRANSLATOR_REASONING_EFFORT: 'max' }, /TRANSLATOR_REASONING_EFFORT/],
  ]) {
    const result = runWithConfig(overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, new RegExp(apiKey));
  }
  const configured = runWithConfig({ TRANSLATOR_MODEL: VENICE_MODEL, TRANSLATOR_REASONING_EFFORT: 'max' });
  assert.equal(configured.status, 0, configured.stderr);
});

test('filters Venice parameters, applies FORCE_MODEL and preserves the original history', () => {
  const client = {
    ...input,
    max_tokens: 90,
    max_completion_tokens: 120,
    temperature: 0.8,
    top_k: 40,
    thinking: { type: 'enabled' },
    reasoning_effort: 'medium',
    reasoning: { effort: 'max', exclude: true, max_tokens: 500 },
    include_reasoning: true,
    route: 'fallback',
    provider: { only: ['old-route'] },
    user_id: 'legacy-id',
    logprobs: true,
    top_logprobs: 10,
    stream_options: { include_usage: false, unknown: true },
    venice_parameters: {
      disable_thinking: true,
      strip_thinking_response: false,
      include_venice_system_prompt: 'false',
      enable_web_search: 'on',
      enable_web_scraping: true,
      enable_x_search: true,
      character_slug: 'other-character',
    },
  };
  const before = structuredClone(client);
  assert.deepEqual(preparePayload(client, { stream: true }), {
    model: VENICE_MODEL,
    messages: injectLanguagePolicy(messages, true),
    stream: true,
    max_completion_tokens: 120,
    temperature: 0.8,
    top_k: 40,
    reasoning_effort: 'max',
    stream_options: { include_usage: false },
    venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true },
  });
  assert.deepEqual(client, before);
});

test('normalizes token limits and forwards only documented thinking controls', () => {
  const model = `${VENICE_MODEL}:enable_web_search=on`;
  const adapted = venicePayload({
    model, stream: false, max_tokens: 1000, stream_options: { include_usage: true },
    venice_parameters: { disable_thinking: true, include_venice_system_prompt: true },
  }, { minCompletionTokens: 1500 });
  assert.deepEqual(adapted, {
    model: VENICE_MODEL, stream: false, max_completion_tokens: 1500,
    venice_parameters: { disable_thinking: true, include_venice_system_prompt: true },
  });
  assert.equal(venicePayload({ model, max_tokens: 0 }).max_completion_tokens, undefined);
  assert.equal(venicePayload({ model, max_tokens: 800 }).max_completion_tokens, 800);
  assert.equal(venicePayload({ model, reasoning_effort: 'low' }, { effort: 'high' }).reasoning_effort, 'high');
  assert.deepEqual(venicePayload({ model, reasoning: { enabled: false, exclude: true } }).reasoning, { enabled: false });
});

test('serves authenticated JSON and prompt SSE with usage and a single DONE', async (t) => {
  const unsubscribe = onLog((record) => logs.push(record));
  const logs = [];
  t.after(unsubscribe);
  const mock = mockVenice(t, (payload, signal) => {
    assert.equal(payload.model, VENICE_MODEL);
    assert.deepEqual(payload.messages, injectLanguagePolicy(messages, true));
    assert.ok(signal instanceof AbortSignal);
    return payload.stream
      ? stream(': keepalive\n\n' + delta({ reasoning_content: 'private reasoning' }) + flow(spanish) + done)
      : completion(spanish, { reasoning_content: 'private reasoning' });
  });

  assert.equal((await request(input, { Origin: 'https://blocked.example' })).status, 403);
  assert.equal((await request(input, { Authorization: `Bearer ${apiKey}` })).status, 401);
  assert.equal(mock.mock.callCount(), 0);
  const json = await request({ messages, stream: false }, { Origin: 'https://janitor.example' });
  assert.equal(json.status, 200);
  assert.equal(json.headers['access-control-allow-origin'], 'https://janitor.example');
  assert.equal(JSON.parse(json.text).choices[0].message.content, spanish);
  const sse = await request({ ...input, stream: true });
  assert.equal(sse.status, 200);
  assert.match(sse.headers['content-type'], /text\/event-stream/);
  assert.match(sse.text, /: keepalive/);
  const frames = sseOutput(sse.text);
  assert.deepEqual(frames.at(-2), { choices: [], usage });
  assert.deepEqual(frames.filter((frame) => frame === '[DONE]'), ['[DONE]']);
  assert.equal(frames.find((frame) => frame.choices?.[0]?.delta?.content)?.choices[0].delta.content, spanish);
  assert.doesNotMatch(json.text + sse.text + JSON.stringify(logs), /private reasoning|Private opening line|venice-fixture-secret/);
  assert.ok(logs.every((log) => log.provider === 'venice'));
  assert.equal(mock.mock.callCount(), 2);
});

test('returns sanitized Venice HTTP errors with the correct status and retry metadata', async (t) => {
  const cases = [
    [400, 'INVALID_REQUEST'],
    [401, 'AUTHENTICATION_FAILED'],
    [402, 'INSUFFICIENT_BALANCE'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [429, 'MODEL_OVERLOADED'],
    [503, 'MODEL_AT_CAPACITY'],
    [504, 'REQUEST_TIMEOUT'],
  ];
  const logs = [];
  t.after(onLog((entry) => logs.push(entry)));
  let index = 0;
  mockVenice(t, () => {
    const [status, code] = cases[index++];
    return Response.json({ error: secretError, code, details: { messages } }, { status, headers: { 'Retry-After': '12' } });
  });
  for (const [status, code] of cases) {
    const response = await request({ ...input, stream: true });
    assert.equal(response.status, status);
    const body = JSON.parse(response.text);
    assert.deepEqual(body.error.upstream, { status, code, retry_after: 12 });
    assert.doesNotMatch(response.text, /venice-fixture-secret|Private opening line/);
  }
  assert.doesNotMatch(JSON.stringify(logs), /venice-fixture-secret|Private opening line/);
  assert.equal(logs.filter((entry) => entry.event === 'request_failed').length, cases.length);
});

test('reports in-band errors before and after visible output without retries or duplicate DONE', async (t) => {
  let prefix = '';
  const mock = mockVenice(t, () => stream(
    prefix + event({ error: { message: secretError, code: 'MODEL_OVERLOADED', retry_after: 9 } }) + done + done,
  ));
  for (const visible of [false, true]) {
    prefix = visible ? delta({ content: spanish }) : delta({ role: 'assistant', reasoning_content: 'private reasoning' });
    const response = await request({ ...input, stream: true });
    assert.equal(response.status, 200);
    const frames = sseOutput(response.text);
    assert.equal(frames.length, visible ? 3 : 2);
    assert.equal(frames.at(-1), '[DONE]');
    assert.deepEqual(frames.at(-2).error.upstream, { status: 429, code: 'MODEL_OVERLOADED', retry_after: 9 });
    assert.doesNotMatch(response.text, /venice-fixture-secret|Private opening line|private reasoning/);
  }
  assert.equal(mock.mock.callCount(), 2);
});

test('rejects an interrupted stream even if content and a finish reason arrived', async (t) => {
  const mock = mockVenice(t, () => stream(delta({ content: spanish }) + delta({}, 'stop') + usageEvent));
  const response = await request({ ...input, stream: true });
  const frames = sseOutput(response.text);
  assert.match(frames.at(-2).error.message, /ended before/);
  assert.equal(frames.at(-1), '[DONE]');
  assert.equal(mock.mock.callCount(), 1);
});

test('aborts the Venice request on timeout and returns HTTP 504', async (t) => {
  const mock = mockVenice(t, (_, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const response = await request(input);
  assert.equal(response.status, 504);
  assert.match(JSON.parse(response.text).error.message, /timed out/);
  assert.equal(mock.mock.callCount(), 1);
});

test('honors backpressure and cancels the upstream body while waiting for drain', { timeout: 2000 }, async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  mockVenice(t, () => new Response(new ReadableStream({
    start(body) { body.enqueue(Buffer.from(flow(spanish))); },
    cancel() { cancelled = true; },
  })));

  const res = Object.assign(new EventEmitter(), {
    writes: [],
    setHeader() {},
    write(value) {
      this.writes.push(value);
      this.emit('wrote');
      return false;
    },
  });
  const wrote = once(res, 'wrote');
  const pending = streamPassthrough(input, res, controller.signal);
  await wrote;
  assert.deepEqual(res.writes, [delta({ content: spanish })]);

  const reason = new Error('Client disconnected');
  controller.abort(reason);
  await assert.rejects(pending, reason);
  assert.equal(cancelled, true);
  assert.equal(res.listenerCount('drain'), 0);
});

test('retries buffered and streaming responses containing only usage, whitespace or reasoning', async (t) => {
  let calls = 0;
  mockVenice(t, (payload) => {
    calls++;
    if (calls % 2 === 1) {
      return payload.stream
        ? stream(delta({ reasoning_content: 'hidden' }) + delta({ content: '  ' }, 'length') + usageEvent + done)
        : completion(null, { reasoning_content: 'hidden' }, 'length');
    }
    assert.match(payload.messages.at(-1).content, /visible final answer/);
    assert.equal(payload.reasoning_effort, 'none');
    return payload.stream ? stream(flow(spanish)) : completion(spanish);
  });
  const json = await request(input);
  assert.equal(JSON.parse(json.text).choices[0].message.content, spanish);
  const sse = await request({ ...input, stream: true });
  const frames = sseOutput(sse.text);
  assert.deepEqual(frames.filter((frame) => frame === '[DONE]'), ['[DONE]']);
  assert.equal(frames.filter((frame) => frame.usage).length, 1);
  assert.match(sse.text, /proxy-retrying-empty-response/);
  assert.equal(calls, 4);
});

test('reports an exhausted retry when SSE contains no visible text', async (t) => {
  const mock = mockVenice(t, () => stream(usageEvent + done));
  const response = await request({ ...input, stream: true });
  const frames = sseOutput(response.text);
  assert.equal(frames.length, 2);
  assert.match(frames[0].error.message, /no visible content after retrying/);
  assert.equal(frames[1], '[DONE]');
  assert.equal(mock.mock.callCount(), 2);
});

test('keeps tool calls as OpenAI-compatible output when content is null', async (t) => {
  const call = { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } };
  const tool = { type: 'function', function: { name: 'lookup' } };
  const mock = mockVenice(t, (payload) => {
    assert.deepEqual(payload.tools, [tool]);
    return payload.stream
      ? stream(delta({ tool_calls: [{ ...call, index: 0 }] }) + delta({}, 'tool_calls') + usageEvent + done)
      : completion(null, { tool_calls: [call] }, 'tool_calls');
  });
  const json = await request({ ...input, tools: [tool] });
  assert.deepEqual(JSON.parse(json.text).choices[0].message, { role: 'assistant', content: null, tool_calls: [call] });
  const sse = await request({ ...input, tools: [tool], stream: true });
  assert.deepEqual(sseOutput(sse.text)[0].choices[0].delta.tool_calls, [{ ...call, index: 0 }]);
  assert.equal(mock.mock.callCount(), 2);
});

test('translates to Latin American Spanish using a native Venice translator in both response formats', async (t) => {
  const mock = mockVenice(t, (payload) => {
    if (payload.model === VENICE_MODEL) return stream(flow(english));
    assert.equal(payload.model, VENICE_TRANSLATOR_MODEL);
    assert.equal(payload.reasoning_effort, 'none');
    assert.equal('provider' in payload, false);
    assert.match(payload.messages[0].content, /Latin American Spanish/);
    assert.equal(payload.messages[1].content, english);
    return payload.stream ? stream(delta({ reasoning_content: 'thinking' }) + flow(spanish)) : completion(spanish);
  });
  assert.deepEqual(await rewriteToSpanish(english, VENICE_MODEL), { text: spanish, model: VENICE_TRANSLATOR_MODEL });
  const res = {
    text: '', headersSent: false, writableEnded: false,
    setHeader() {},
    flushHeaders() { this.headersSent = true; },
    write(value) { this.text += value; return true; },
    end(value = '') { this.text += value; this.writableEnded = true; },
  };
  const meta = await streamSmart(input, res);
  assert.equal(meta.rewritten, true);
  assert.equal(meta.translator_model, VENICE_TRANSLATOR_MODEL);
  assert.doesNotMatch(res.text, /looks at him|thinking/);
  const frames = sseOutput(res.text);
  assert.equal(frames[1].choices[0].delta.content, spanish);
  assert.deepEqual(frames.filter((frame) => frame === '[DONE]'), ['[DONE]']);
  assert.equal(mock.mock.callCount(), 3);
});

test('auto and strict keep buffered SSE and use the configured Venice translator', () => {
  for (const mode of ['auto', 'strict']) {
    const result = runWithConfig({ OUTPUT_MODE: mode, TRANSLATOR_MODEL: 'deepseek-v4-1-flash-1017' }, `
      import assert from 'node:assert/strict';
      const { completeBuffered, sendBufferedAsSse } = await import('./src/proxy.js');
      const original = ${JSON.stringify(mode === 'auto' ? english : spanish)};
      const translated = ${JSON.stringify(spanish)};
      let calls = 0;
      global.fetch = async (url, options) => {
        assert.equal(url, 'https://api.venice.ai/api/v1/chat/completions');
        const payload = JSON.parse(options.body);
        assert.equal(payload.stream, false);
        assert.equal(payload.stream_options, undefined);
        if (++calls === 1) assert.equal(payload.model, ${JSON.stringify(VENICE_MODEL)});
        else {
          assert.equal(payload.model, 'deepseek-v4-1-flash-1017');
          assert.equal(payload.messages[1].content, original);
        }
        return Response.json({
          choices: [{ message: { content: calls === 1 ? original : translated }, finish_reason: 'stop' }],
          usage: { total_tokens: 112 },
        });
      };
      const { json, meta } = await completeBuffered({ messages: [], stream: true, stream_options: { include_usage: true } });
      assert.equal(calls, 2);
      assert.equal(meta.rewritten, true);
      assert.equal(json.choices[0].message.content, translated);
      const res = {
        text: '', setHeader() {}, write(value) { this.text += value; return true; },
        end(value = '') { this.text += value; this.writableEnded = true; },
      };
      await sendBufferedAsSse(res, json);
      assert.ok(res.text.includes(JSON.stringify(translated)));
      assert.ok(res.text.includes('"choices":[],"usage":{"total_tokens":112}'));
      assert.equal(res.text.split('data: [DONE]').length, 2);
    `);
    assert.equal(result.status, 0, result.stderr);
  }
});
