import test from 'node:test';
import assert from 'node:assert/strict';
import { injectLanguagePolicy, shouldRewriteToSpanish } from '../src/language.js';

test('wraps an existing system message without removing it', () => {
  const input = [{ role: 'system', content: 'Stay in character.' }, { role: 'user', content: 'Hola' }];
  const result = injectLanguagePolicy(input, true);
  assert.equal(result.length, 2);
  assert.match(result[0].content, /Latin American Spanish/i);
  assert.match(result[0].content, /Stay in character\./);
  assert.equal(input[0].content, 'Stay in character.');
});

test('adds a system message when none exists', () => {
  const result = injectLanguagePolicy([{ role: 'user', content: 'Hola' }], true);
  assert.equal(result[0].role, 'system');
  assert.equal(result[1].role, 'user');
});

test('detects predominantly English output', () => {
  assert.equal(shouldRewriteToSpanish('She looks at him and then turns away. The rain is still falling on the street.'), true);
});

test('keeps predominantly Spanish output', () => {
  assert.equal(shouldRewriteToSpanish('Ella lo mira y después aparta la vista. La lluvia sigue cayendo sobre la calle.'), false);
});
