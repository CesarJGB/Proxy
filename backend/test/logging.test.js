import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { config } from '../src/config.js';
import { handleChat, server } from '../src/server.js';
import { onLog, clearLogListeners } from '../src/logger.js';

class FakeRequest extends EventEmitter {
  constructor(body, headers = {}) {
    super();
    this.method = 'POST';
    this.url = '/v1/chat/completions';
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

  getHeader(name) {
    return this.headers[name.toLowerCase()];
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

class BackpressureHangingResponse extends FakeResponse {
  write(value) {
    this.headersSent = true;
    this.output += String(value);
    return false;
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

test('1. éxito normal: registra request_started y request_completed con el mismo request_id', async () => {
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
    assert.equal(completed.final, true);
    assert.ok(Number.isFinite(completed.elapsed_ms));

    const terminals = logs.filter((l) => l.request_id === completed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('2. HTTP 500 upstream: registra upstream_attempt_failed y request_failed con el mismo request_id', async () => {
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
    assert.equal(attemptFailed.final, false, 'Intento fallido debe tener final: false');
    assert.equal(requestFailed.upstream_status, 500);
    assert.equal(requestFailed.final, true, 'Terminal request_failed debe tener final: true');

    const terminals = logs.filter((l) => l.request_id === requestFailed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('3. conexión rechazada antes de respuesta: registra error de conexión con mismo request_id', async () => {
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
    assert.equal(attemptFailed.final, false);
    assert.equal(requestFailed.error_type, 'upstream_closed_connection');
    assert.equal(requestFailed.final, true);

    const terminals = logs.filter((l) => l.request_id === requestFailed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('4. corte upstream durante streaming: registra el error tras enviar headers', async () => {
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
    assert.equal(attemptFailed.final, false);
    assert.equal(requestFailed.stream, true);
    assert.equal(requestFailed.final, true);

    // Janitor receives SSE error event and [DONE]
    assert.match(res.output, /data: \[DONE\]/);

    const terminals = logs.filter((l) => l.request_id === requestFailed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('5. primer intento vacío + segundo exitoso: reconstruye intento 1 falló -> intento 2 ok', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return okStream([finishEvent()]);
    }
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
    assert.equal(completed.final, true);
    assert.equal(attempt1.request_id, completed.request_id);

    const terminals = logs.filter((l) => l.request_id === completed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('6. todos los retries vacíos agotados: registra cada intento y el request_failed final con mismo request_id', async () => {
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
    assert.equal(attempt2.final, false, 'Intento 2 upstream_attempt_failed debe tener final: false');

    assert.ok(requestFailed, 'Debe registrar request_failed final');
    assert.equal(requestFailed.final, true);
    assert.equal(requestFailed.attempts, 2);

    assert.equal(attempt1.request_id, requestFailed.request_id);
    assert.equal(attempt2.request_id, requestFailed.request_id);

    const terminals = logs.filter((l) => l.request_id === requestFailed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('7. validación 400 por payload inválido registra request_failed con invalid_request_error', async () => {
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  const req = new FakeRequest({
    model: 'test-model',
    messages: null,
  });
  const res = new FakeResponse();

  try {
    await handleChat(req, res);

    assert.equal(res.statusCode, 400);

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed, 'Debe registrar request_failed');
    assert.equal(failed.stage, 'validation');
    assert.equal(failed.error_type, 'invalid_request_error');
    assert.equal(failed.error_code, 400);
    assert.equal(failed.final, true);

    const completed = logs.find((l) => l.event === 'request_completed');
    assert.equal(completed, undefined);

    const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    unsubscribe();
  }
});

test('8. excepción interna REAL registra request_failed con error_type internal_error', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => {
    throw new Error('boom inesperado');
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: false,
    });
    const res = new FakeResponse();

    await handleChat(req, res);

    assert.equal(res.statusCode, 502);

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed, 'Debe registrar request_failed');
    assert.equal(failed.error_type, 'internal_error');
    assert.equal(failed.final, true);
    assert.match(failed.error_message, /boom inesperado/);

    const completed = logs.find((l) => l.event === 'request_completed');
    assert.equal(completed, undefined);

    const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('9. cliente cancela stream normal registra client_disconnected y client_closed_connection', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async (_url, { signal }) => {
    async function* hangingStream() {
      yield Buffer.from(contentEvent('Parte 1'));
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

    const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('10. cliente cancela mientras esperamos drain: handleChat termina y registra client_closed_connection', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => {
    const spanish = 'Ella lo mira fijamente mientras la lluvia cae. '.repeat(10);
    return okStream([contentEvent(spanish), finishEvent()]);
  };

  try {
    const req = new FakeRequest({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hola' }],
      stream: true,
    });
    const res = new BackpressureHangingResponse();

    // The client disconnects while writeWithBackpressure is waiting on drain
    setTimeout(() => {
      res.simulateClientDisconnect();
    }, 10);

    await handleChat(req, res);

    const failedList = logs.filter((l) => l.event === 'request_failed');
    assert.equal(failedList.length, 1, 'Debe registrar exactamente un request_failed');

    const failed = failedList[0];
    assert.equal(failed.error_type, 'client_closed_connection');
    assert.equal(failed.client_disconnected, true);
    assert.equal(failed.final, true);

    const completed = logs.find((l) => l.event === 'request_completed');
    assert.equal(completed, undefined);

    const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('11. auth 401 registra request_failed antes de contactar al proveedor', async () => {
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

    const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    unsubscribe();
  }
});

test('12. CORS 403 en /v1/chat/completions registra request_failed antes de handleChat con request_id', async () => {
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));
  const oldCors = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://trusted-site.com';

  try {
    const req = new FakeRequest(
      { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'Hola' }] },
      { origin: 'https://malicious-site.com' }
    );
    req.url = '/v1/chat/completions';
    const res = new FakeResponse();

    await new Promise((resolve) => {
      res.once('finish', resolve);
      server.emit('request', req, res);
    });

    assert.equal(res.statusCode, 403);
    const requestId = res.getHeader('x-proxy-request-id');
    assert.ok(requestId, 'Debe incluir header X-Proxy-Request-Id');

    const failed = logs.find((l) => l.event === 'request_failed');
    assert.ok(failed, 'Debe registrar request_failed');
    assert.equal(failed.request_id, requestId);
    assert.equal(failed.stage, 'cors');
    assert.equal(failed.status, 403);
    assert.equal(failed.final, true);
    assert.equal(failed.error_type, 'cors_forbidden');

    const terminals = logs.filter((l) => l.request_id === requestId && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento terminal');
  } finally {
    if (oldCors !== undefined) process.env.CORS_ORIGIN = oldCors;
    else delete process.env.CORS_ORIGIN;
    unsubscribe();
  }
});

test('13. sanitización de secretos y contenido del usuario en error.details', async () => {
  const originalFetch = global.fetch;
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  global.fetch = async () => ({
    ok: false,
    status: 502,
    async text() {
      return JSON.stringify({
        error: {
          message: 'Error de proveedor con Bearer secret_openrouter_key_xyz',
          type: 'upstream_error',
          code: 'bad_gateway',
          prompt: 'prompt secreto anidado en error',
        },
        metadata: {
          api_key: 'sk-abcdef123456',
          Authorization: 'Bearer supersecretpassword',
          messages: [{ role: 'user', content: 'prompt secreto de prueba que no debe verse' }],
          prompt: 'prompt de alto nivel confidencial',
          response: 'respuesta del modelo confidencial',
          output: 'salida generada confidencial',
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
    assert.ok(failed, 'Debe registrar request_failed');

    const jsonStr = JSON.stringify(failed);
    // Secrets
    assert.doesNotMatch(jsonStr, /secret_openrouter_key_xyz/);
    assert.doesNotMatch(jsonStr, /sk-abcdef123456/);
    assert.doesNotMatch(jsonStr, /supersecretpassword/);
    // User content / prompts / responses
    assert.doesNotMatch(jsonStr, /prompt secreto de prueba que no debe verse/);
    assert.doesNotMatch(jsonStr, /prompt de alto nivel confidencial/);
    assert.doesNotMatch(jsonStr, /prompt secreto anidado/);
    assert.doesNotMatch(jsonStr, /respuesta del modelo confidencial/);
    assert.doesNotMatch(jsonStr, /salida generada confidencial/);

    // Diagnostic safe keys must still exist
    assert.equal(failed.details?.error?.type, 'upstream_error');
    assert.equal(failed.details?.error?.code, 'bad_gateway');

    const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
    assert.equal(terminals.length, 1, 'Debe haber exactamente un evento final: true');
  } finally {
    global.fetch = originalFetch;
    unsubscribe();
  }
});

test('14. excepción inesperada en el handler HTTP exterior genera request_id y request_failed', async () => {
  const logs = [];
  const unsubscribe = onLog((entry) => logs.push(entry));

  const req = new FakeRequest(
    { model: 'test-model', messages: [{ role: 'user', content: 'Hola' }] },
    {}
  );
  // Simulate an unexpected error in routing/middleware by causing headers access to throw
  Object.defineProperty(req, 'headers', {
    get() {
      throw new Error('Unexpected crash in outer HTTP handler');
    },
  });
  req.url = '/v1/chat/completions';
  const res = new FakeResponse();

  await new Promise((resolve) => {
    res.once('finish', resolve);
    server.emit('request', req, res);
  });

  assert.equal(res.statusCode, 500);

  const clientBody = JSON.parse(res.output);
  // Client gets generic message, not the internal stack/details
  assert.equal(clientBody.error.message, 'Internal server error');
  assert.equal(clientBody.error.type, 'internal_error');

  const failed = logs.find((l) => l.event === 'request_failed');
  assert.ok(failed, 'Debe registrar request_failed en fallo inesperado exterior');
  assert.ok(failed.request_id, 'Debe incluir request_id');
  assert.ok(failed.route, 'Debe incluir route');
  assert.equal(failed.stage, 'routing');
  assert.ok(Number.isFinite(failed.elapsed_ms));
  assert.equal(failed.error_type, 'internal_error');
  assert.equal(failed.error_code, 'internal_error');
  assert.equal(failed.error_message, 'Unexpected crash in outer HTTP handler');
  assert.equal(failed.final, true);

  const terminals = logs.filter((l) => l.request_id === failed.request_id && l.final === true);
  assert.equal(terminals.length, 1, 'Debe haber exactamente un evento terminal');

  unsubscribe();
});
