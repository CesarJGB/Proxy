import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOutputLanguage,
  injectLanguagePolicy,
  shouldRewriteToSpanish,
} from '../src/language.js';

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
  const text = 'She looks at him and then turns away. The rain is still falling on the street.';
  assert.equal(shouldRewriteToSpanish(text), true);
  assert.equal(detectOutputLanguage(text), 'en');
});

test('keeps predominantly Spanish output', () => {
  const text = 'Ella lo mira y después aparta la vista. La lluvia sigue cayendo sobre la calle.';
  assert.equal(shouldRewriteToSpanish(text), false);
  assert.equal(detectOutputLanguage(text), 'es');
});

test('detects a roleplay sample with English narration even when dialogue contains Spanish', () => {
  const text = `Her ears twitch once as she looks toward him. She does not run. She stays beside the bowl and watches him carefully. "Buenas noches", she says softly, then looks away as the rain keeps falling around them.`;
  assert.equal(detectOutputLanguage(text), 'en');
});
