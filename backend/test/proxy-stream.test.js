import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseEvent, reasoningSize } from '../src/proxy.js';

test('parses OpenAI-compatible SSE content chunks', () => {
  const raw = 'data: {"choices":[{"delta":{"content":"Hola mundo"},"finish_reason":null}]}';
  const parsed = parseSseEvent(raw);
  assert.equal(parsed.kind, 'chunk');
  assert.equal(parsed.content, 'Hola mundo');
  assert.equal(parsed.reasoningChars, 0);
});

test('recognizes SSE DONE marker', () => {
  assert.equal(parseSseEvent('data: [DONE]').kind, 'done');
});

test('empty reasoning_details does not count as two reasoning chars', () => {
  const json = {
    choices: [{
      message: {
        content: 'Hola',
        reasoning_details: [],
      },
    }],
  };
  assert.equal(reasoningSize(json), 0);
});
