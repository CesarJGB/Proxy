import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { config } from '../src/config.js';
import { handleChat } from '../src/server.js';
import { onLog, clearLogListeners } from '../src/logger.js';

class FakeRequest extends EventEmitter {
  constructor(body, headers = {}) {
    super();
    this.method = 'POST';
    this.headers = {
      authorization: `Bearer ${config.proxyApiKey}`,
      'content-type': 'application/json',
      ...headers,
    };
    this.bodyData = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  }

  async *[Symbol.asyncIterator]() {
    if (this.bodyData) {
      yield Buffer.from(this.bodyData);
    }
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.writableEnded = false;
    this.statusCode = 200;
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
    this.emit('finish');
    this.emit('close');
  }

  simulateClientDisconnect() {
    if (!this.writableEnded) {
      this.emit('close');
    }
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

test('1. request exitosa registra request_started y request_completed con el mismo request_id', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => {
    const spanish = 'Ella lo mira fijamente en silencio mientras la lluvia cae. '.repeat(10);
    return okStream([contentEvent(spanish), finishEvent()]);
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(res.statusCode, 200);

    const started = logs.find((l) => l.event === 'request_started');
    const completed = logs.find((l) => l.event === 'request_completed');

    assert.ok(started, 'Debe registrar request_started');
    assert.ok(completed, 'Debe registrar request_completed');
    assert.equal(started.request_id, completed.request_id);
    assert.equal(completed.level, 'info');
    assert.equal(completed.attempts, 1);
    assert.equal(completed.stream, true);
    assert.equal(completed.model, 'deepseek/deepseek-v4-flash');
    assert.equal(completed.route, 'chat');
    assert.ok(Number.isFinite(completed.elapsed_ms));
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('2. upstream devuelve 500 registra upstream_attempt_failed y request_failed con el mismo request_id', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      return JSON.stringify({ error: { message: 'Upstream server error' } });
    },
  });

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(res.statusCode, 500);

    const attemptFailed = logs.find((l) => l.event === 'upstream_attempt_failed');
    const requestFailed = logs.find((l) => l.event === 'request_failed');

    assert.ok(attemptFailed, 'Debe registrar upstream_attempt_failed');
    assert.ok(requestFailed, 'Debe registrar request_failed');
    assert.equal(attemptFailed.request_id, requestFailed.request_id);
    assert.equal(attemptFailed.error_type, 'upstream_http_error');
    assert.equal(attemptFailed.upstream_status, 500);
    assert.equal(attemptFailed.retryable, false);
    assert.equal(attemptFailed.final, true);
    assert.equal(requestFailed.upstream_status, 500);
    assert.equal(requestFailed.final, true);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('3. conexión upstream falla antes de responder registra error de conexión con mismo request_id', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => {
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    throw connErr;
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(res.statusCode, 502);

    const attemptFailed = logs.find((l) => l.event === 'upstream_attempt_failed');
    const requestFailed = logs.find((l) => l.event === 'request_failed');

    assert.ok(attemptFailed, 'Debe registrar upstream_attempt_failed');
    assert.ok(requestFailed, 'Debe registrar request_failed');
    assert.equal(attemptFailed.request_id, requestFailed.request_id);
    assert.equal(attemptFailed.stage, 'upstream_connect');
    assert.equal(attemptFailed.error_type, 'upstream_closed_connection');
    assert.equal(attemptFailed.error_code, 'ECONNREFUSED');
    assert.equal(requestFailed.error_type, 'upstream_closed_connection');
    assert.equal(requestFailed.final, true);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('4. conexión upstream se corta durante streaming registra el error tras enviar headers', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => {
    async function* brokenStream() {
      yield Buffer.from(contentEvent('Hola '));
      const err = new Error('terminated');
      err.code = 'UND_ERR_SOCKET';
      throw err;
    }
    return {
      ok: true,
      status: 200,
      body: Readable.from(brokenStream()),
      async text() { return ''; },
    };
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(res.headersSent, true);

    const attemptFailed = logs.find((l) => l.event === 'upstream_attempt_failed');
    const requestFailed = logs.find((l) => l.event === 'request_failed');

    assert.ok(attemptFailed, 'Debe registrar upstream_attempt_failed');
    assert.ok(requestFailed, 'Debe registrar request_failed');
    assert.equal(attemptFailed.request_id, requestFailed.request_id);
    assert.equal(attemptFailed.stage, 'stream');
    assert.equal(attemptFailed.error_type, 'upstream_closed_connection');
    assert.equal(requestFailed.stream, true);
    assert.equal(requestFailed.final, true);

    // Janitor receives SSE error event and [DONE]
    assert.match(res.output, /data: \[DONE\]/);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('5. primer intento falla y segundo funciona reconstruye intento 1 falló -> intento 2 ok', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      // Empty visible response (e.g. reasoning only or whitespace)
      return okStream([finishEvent()]);
    }
    // Second attempt produces valid Spanish content
    const spanish = 'Respuesta en español válida para el roleplay. '.repeat(10);
    return okStream([contentEvent(spanish), finishEvent()]);
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(calls, 2);

    const attempt1 = logs.find((l) => l.event === 'upstream_attempt_failed' && l.attempt === 1);
    const completed = logs.find((l) => l.event === 'request_completed');

    assert.ok(attempt1, 'Debe registrar fallo del intento 1');
    assert.equal(attempt1.retryable, true);
    assert.equal(attempt1.final, false);
    assert.equal(attempt1.error_type, 'empty_response');

    assert.ok(completed, 'Debe registrar request_completed al segundo intento');
    assert.equal(completed.attempts, 2);
    assert.equal(attempt1.request_id, completed.request_id);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('6. todos los intentos fallan registra cada intento y el request_failed final con mismo request_id', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    return okStream([finishEvent()]);
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(calls, config.emptyResponseRetry + 1);

    const attempt1 = logs.find((l) => l.event === 'upstream_attempt_failed' && l.attempt === 1);
    const attempt2 = logs.find((l) => l.event === 'upstream_attempt_failed' && l.attempt === 2);
    const requestFailed = logs.find((l) => l.event === 'request_failed');

    assert.ok(attempt1, 'Debe registrar intento 1 fallido');
    assert.equal(attempt1.retryable, true);
    assert.equal(attempt1.final, false);

    assert.ok(attempt2, 'Debe registrar intento 2 fallido');
    assert.equal(attempt2.retryable, false);
    assert.equal(attempt2.final, true);

    assert.ok(requestFailed, 'Debe registrar request_failed final');
    assert.equal(requestFailed.final, true);
    assert.equal(requestFailed.attempts, 2);

    assert.equal(attempt1.request_id, requestFailed.request_id);
    assert.equal(attempt2.request_id, requestFailed.request_id);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('7. excepción interna inesperada registra request_failed con error_type internal_error', async () => {
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  // Request with invalid messages structure that bypasses initial check or triggers internal error
  const req = new FakeRequest({
    model: 'test-model',
    messages: null, // triggers validation error
  });
  const res = new FakeResponse();

  try {
    await handleChat(req, res);

    assert.equal(res.statusCode, 400);

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed, 'Debe registrar request_failed');
    assert.equal(failed.stage, 'validation');
    assert.equal(failed.error_type, 'invalid_request_error');
    assert.equal(failed.final, true);
  } finally {
    unsubscribe();
  }
});

test('8. cliente cancela un stream registra client_disconnected y client_closed_connection', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  let fetchAborted = false;
  global.fetch = async (_url, { signal }) => {
    signal.addEventListener('abort', () => { fetchAborted = true; });
    async function* hangingStream() {
      yield Buffer.from(contentEvent('Parte 1'));
      // Wait for abort
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      yield Buffer.from(contentEvent('Parte 2'));
    }
    return {
      ok: true,
      status: 200,
      body: Readable.from(hangingStream()),
      async text() { return ''; },
    };
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new FakeResponse();

    // Simulate client closing connection while handling
    setTimeout(() => {
      res.simulateClientDisconnect();
    }, 10);

    await handleChat(req, res);

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed, 'Debe registrar request_failed');
    assert.equal(failed.client_disconnected, true);
    assert.equal(failed.error_type, 'client_closed_connection');
    assert.equal(failed.error_code, 'client_disconnected');
    assert.equal(failed.final, true);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('9. fallo de autenticación 401 registra request_failed antes de contactar al proveedor', async () => {
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  const req = new FakeRequest(
    { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'Hola' }] },
    { authorization: 'Bearer clave-invalida-123456789' }
  );
  const res = new FakeResponse();

  try {
    await handleChat(req, res);

    assert.equal(res.statusCode, 401);

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed, 'Debe registrar request_failed en auth');
    assert.equal(failed.stage, 'auth');
    assert.equal(failed.error_type, 'authentication_error');
    assert.equal(failed.error_code, 401);
    assert.equal(failed.final, true);
    assert.equal(failed.attempts, 0);
  } finally {
    unsubscribe();
  }
});

test('10. sanitización no expone API keys ni autorización en los logs', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({
        error: {
          message: 'Invalid key Bearer secret_openrouter_key_xyz',
          metadata: { api_key: 'sk-abcdef123456', password: 'supersecretpassword' },
        },
      });
    },
  });

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed);

    const jsonStr = JSON.stringify(failed);
    assert.doesNotMatch(jsonStr, /secret_openrouter_key_xyz/);
    assert.doesNotMatch(jsonStr, /sk-abcdef123456/);
    assert.doesNotMatch(jsonStr, /supersecretpassword/);
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});
