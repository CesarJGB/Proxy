import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { streamSmart } from '../src/proxy.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.writableEnded = false;
    this.statusCode = 0;
    this.headers = {};
    this.output = '';
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(value) {
    this.headersSent = true;
    this.output += String(value);
    return true;
  }

  end(value = '') {
    if (value) this.write(value);
    this.writableEnded = true;
  }
}

function sseBody(chunks) {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

function okStream(events) {
  return {
    ok: true,
    status: 200,
    body: sseBody(events),
    async text() { return ''; },
  };
}

function contentEvent(text, model = 'test-model') {
  return `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

function finishEvent(model = 'test-model') {
  return `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`;
}

test('smart mode passes Spanish through and closes the response', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    const spanish = 'Ella lo mira en silencio mientras la lluvia cae sobre la calle. '.repeat(20);
    return okStream([contentEvent(spanish), finishEvent()]);
  };

  try {
    const res = new FakeResponse();
    const meta = await streamSmart({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    }, res, new AbortController().signal);

    assert.equal(calls, 1);
    assert.equal(meta.rewritten, false);
    assert.equal(meta.language_detected, 'es');
    assert.equal(meta.stream_strategy, 'smart_passthrough');
    assert.match(res.output, /Ella lo mira/);
    assert.equal(res.writableEnded, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('smart mode suppresses English source and streams only Spanish rewrite', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);

    if (calls === 1) {
      const english = 'She looks at him and then turns away while the rain keeps falling around them. '.repeat(20);
      return okStream([contentEvent(english, payload.model), finishEvent(payload.model)]);
    }

    assert.equal(payload.model, 'openai/gpt-oss-20b:nitro');
    assert.equal(payload.stream, true);
    const spanish = 'Ella lo mira y luego aparta la vista mientras la lluvia sigue cayendo a su alrededor. '.repeat(12);
    return okStream([contentEvent(spanish, payload.model), finishEvent(payload.model)]);
  };

  try {
    const res = new FakeResponse();
    const meta = await streamSmart({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    }, res, new AbortController().signal);

    assert.equal(calls, 2);
    assert.equal(meta.rewritten, true);
    assert.equal(meta.language_detected, 'en');
    assert.equal(meta.stream_strategy, 'smart_rewrite_stream');
    assert.equal(meta.translator_model, 'openai/gpt-oss-20b:nitro');
    assert.doesNotMatch(res.output, /She looks at him/);
    assert.match(res.output, /Ella lo mira/);
    assert.equal(res.writableEnded, true);
  } finally {
    global.fetch = originalFetch;
  }
});
