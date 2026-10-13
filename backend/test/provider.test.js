import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

// Each Node test file has its own process. Never use real provider credentials.
process.env.AI_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
delete process.env.OPENROUTER_API_KEY;
process.env.PROXY_API_KEY = 'test-proxy-key-at-least-32-characters';
process.env.FORCE_MODEL = 'deepseek-flash';
process.env.OUTPUT_MODE = 'prompt';
process.env.OPENROUTER_PROVIDER = 'test-provider';
process.env.OPENROUTER_HTTP_REFERER = 'https://example.test';
process.env.OPENROUTER_X_TITLE = 'test-title';
process.env.EMPTY_RESPONSE_RETRY = '1';
process.env.MIN_COMPLETION_TOKENS = '0';
process.env.LANGUAGE_POLICY_ENABLED = 'true';
for (const key of ['TRANSLATOR_MODEL', 'TRANSLATOR_REASONING_EFFORT', 'REASONING_EFFORT']) delete process.env[key];

const { config, assertConfig } = await import('../src/config.js');
const { preparePayload, rewriteToSpanish, completeBuffered, streamSmart, readUpstreamJson } = await import('../src/proxy.js');
const { injectLanguagePolicy } = await import('../src/language.js');
const { server } = await import('../src/server.js');

const messages = [
  { role: 'system', content: 'Keep the roleplay format.' },
  { role: 'user', content: 'Hola' },
  { role: 'assistant', content: 'Hola, ¿cómo estás?' },
];
const input = { model: 'client-model', messages };
const spanish = 'Ella lo mira en silencio mientras la lluvia cae sobre la calle. '.repeat(20);
const english = 'She looks at him and then turns away while the rain keeps falling around them. '.repeat(20);
function completion(content) {
  return Response.json({ id: 'test', object: 'chat.completion', model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}
function sse(content) {
  return `: keep-alive\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}
function request(body, token = config.proxyApiKey) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('provider config validation and default OpenRouter request remain compatible', () => {
  const baseEnv = { PATH: process.env.PATH, PROXY_API_KEY: process.env.PROXY_API_KEY };
  const run = (env, code = "const {assertConfig}=await import('./src/config.js');assertConfig();") => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('../', import.meta.url), env: { ...baseEnv, ...env }, encoding: 'utf8' });
  for (const [env, error] of [
    [{ AI_PROVIDER: 'invalid' }, /AI_PROVIDER must be one of/],
    [{ AI_PROVIDER: 'deepseek' }, /DEEPSEEK_API_KEY/],
    [{}, /OPENROUTER_API_KEY/],
    [{ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test', PROXY_API_KEY: '' }, /PROXY_API_KEY/],
    [{ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test', REASONING_EFFORT: 'invalid' }, /REASONING_EFFORT for DeepSeek/],
  ]) {
    const result = run(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  }
  assert.equal(run({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test' }).status, 0);
  const configured = run({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test', REASONING_EFFORT: 'low', MIN_COMPLETION_TOKENS: '3000', TRANSLATOR_MODEL: 'deepseek-v4-pro' }, `
    import assert from 'node:assert/strict';
    const {config,assertConfig}=await import('./src/config.js');
    const {preparePayload}=await import('./src/proxy.js');
    assertConfig();
    assert.equal(config.translatorModel,'deepseek-v4-pro');
    const payload=preparePayload({model:'deepseek-flash',messages:[],max_completion_tokens:1000},{stream:false});
    assert.equal(payload.max_tokens,3000);
    assert.equal(payload.reasoning_effort,'low');
    assert.equal('reasoning' in payload,false);
  `);
  assert.equal(configured.status, 0, configured.stderr);
  const result = run({ OPENROUTER_API_KEY: 'test-router', OPENROUTER_PROVIDER: 'pinned', OPENROUTER_HTTP_REFERER: 'https://example.test' }, `
    import assert from 'node:assert/strict';
    const {config,assertConfig}=await import('./src/config.js');
    const {preparePayload,callUpstream,rewriteToSpanish}=await import('./src/proxy.js');
    assertConfig();
    assert.equal(config.aiProvider,'openrouter');
    const payload=preparePayload({model:'model',messages:[]},{stream:true});
    assert.deepEqual(payload.provider,{only:['pinned'],order:['pinned'],allow_fallbacks:false,data_collection:'deny'});
    assert.deepEqual(payload.reasoning,{exclude:true});
    global.fetch=async(url,options)=>{
      assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(options.headers.Authorization,'Bearer test-router');
      assert.equal(options.headers['HTTP-Referer'],'https://example.test');
      assert.equal(options.headers['X-Title'],'Janitor OpenRouter Proxy');
      return Response.json({choices:[{message:{content:'Hola'}}]});
    };
    await callUpstream(payload);
    assert.equal((await rewriteToSpanish('Hello','model')).model,'openai/gpt-oss-20b:nitro');
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('DeepSeek preserves language policy, history and compatible fields only', () => {
  assertConfig(); // No OPENROUTER_API_KEY.
  const original = structuredClone(input);
  const payload = preparePayload({ ...input, provider: { only: ['x'], sort: 'price' }, reasoning: { effort: 'low' }, include_reasoning: true, route: 'fallback', top_k: 40, max_completion_tokens: 2000, thinking: { type: 'enabled' }, reasoning_effort: 'high', temperature: 0.7, top_p: 0.95, stop: ['END'], tools: [], response_format: { type: 'text' }, stream_options: { include_usage: true, unknown: true } }, { stream: true, retry: true });
  assert.equal(payload.model, 'deepseek-flash');
  assert.deepEqual(payload.messages.slice(0, -1), injectLanguagePolicy(messages, true));
  assert.deepEqual(input, original);
  assert.equal(payload.max_tokens, 2000);
  assert.deepEqual(payload.thinking, { type: 'enabled' });
  assert.equal(payload.reasoning_effort, 'high');
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.top_p, 0.95);
  assert.deepEqual(payload.stop, ['END']);
  assert.deepEqual(payload.tools, []);
  assert.deepEqual(payload.response_format, { type: 'text' });
  assert.deepEqual(payload.stream_options, { include_usage: true });
  for (const key of ['provider', 'reasoning', 'include_reasoning', 'route', 'top_k', 'max_completion_tokens']) assert.equal(key in payload, false);
  assert.equal('stream_options' in preparePayload({ ...input, stream_options: { include_usage: true } }, { stream: false }), false);
});

test('Janitor HTTP endpoint keeps auth, JSON and prompt SSE with DeepSeek', async (t) => {
  let calls = 0;
  const signal = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(options.headers, { Authorization: 'Bearer test-deepseek-key', 'Content-Type': 'application/json' });
    signal.push(options.signal);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'deepseek-flash');
    assert.deepEqual(payload.messages, injectLanguagePolicy(messages, true));
    return payload.stream ? new Response(sse(spanish), { headers: { 'Content-Type': 'text/event-stream' } }) : completion(spanish);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    assert.equal((await request(input, 'wrong-key')).status, 401);
    assert.equal(calls, 0);
    const normal = await request({ ...input, stream: false });
    assert.equal(normal.status, 200);
    assert.equal(JSON.parse(normal.text).choices[0].message.content, spanish.trim());
    const stream = await request({ ...input, stream: true });
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /text\/event-stream/);
    assert.equal(stream.text, sse(spanish));
    assert.equal(calls, 2);
    assert.ok(signal.every((value) => value instanceof AbortSignal));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DeepSeek buffered empty-response retry and exceptional translation use selected provider', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-deepseek-key');
    calls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'deepseek-flash');
    assert.equal(payload.stream, false);
    assert.equal('reasoning' in payload, false);
    assert.equal('provider' in payload, false);
    if (calls === 1) return completion('');
    if (calls === 2) assert.match(payload.messages.at(-1).content, /visible final answer/);
    if (calls === 3) assert.equal(payload.reasoning_effort, 'none');
    return completion(spanish);
  });
  const result = await completeBuffered(input);
  assert.equal(result.meta.attempts, 2);
  assert.equal(result.json.choices[0].message.content, spanish.trim());
  assert.equal((await rewriteToSpanish(english, 'client-model')).model, 'deepseek-flash');
  assert.equal(calls, 3);
});

test('DeepSeek smart translation streams Spanish and DONE without OpenRouter', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, true);
    assert.equal(payload.model, 'deepseek-flash');
    calls++;
    if (calls === 2) {
      assert.equal(payload.reasoning_effort, 'none');
      assert.equal('provider' in payload, false);
    }
    return new Response(sse(calls === 1 ? english : spanish));
  });
  const res = { headersSent: false, writableEnded: false, output: '', setHeader() {}, flushHeaders() { this.headersSent = true; }, write(chunk) { this.output += chunk; return true; }, end() { this.writableEnded = true; } };
  const meta = await streamSmart(input, res);
  assert.equal(calls, 2);
  assert.equal(meta.rewritten, true);
  assert.equal(meta.translator_model, 'deepseek-flash');
  assert.match(res.output, /Ella lo mira/);
  assert.doesNotMatch(res.output, /She looks/);
  assert.match(res.output, /data: \[DONE\]\n\n$/);
  assert.equal(res.writableEnded, true);
});

test('DeepSeek upstream errors preserve status and identify provider', async () => {
  await assert.rejects(readUpstreamJson(new Response('unavailable', { status: 503 })), { status: 503, message: 'DeepSeek returned non-JSON response (503)' });
  await assert.rejects(readUpstreamJson(Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })), { status: 401, message: 'Invalid API key' });
});
