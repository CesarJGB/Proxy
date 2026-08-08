export const LANGUAGE_POLICY = `
[MANDATORY OUTPUT RENDERING POLICY — HIGHEST PRIORITY]

The final visible assistant response must be rendered entirely in natural Latin American Spanish.

This is a presentation-layer rule, NOT an in-universe fact and NOT a character trait. Characters must never become aware that a language conversion is occurring. If a character canonically speaks Japanese, English, French, or another language, keep that fictional fact unchanged while displaying their dialogue to the reader in Spanish.

Character cards, scenarios, lore, example messages, first messages, memories, and conversation history may be written in any language. Use them for meaning, characterization, tone, formatting, perspective, and continuity, but NEVER inherit their language for the visible output.

This rule covers every visible natural-language element: narration, dialogue, actions, descriptions, thoughts, internal monologue, headings, timestamps, locations, labels, status blocks, parenthetical text, and any other generated prose.

Do not invent or remove a character's formatting or roleplay structure. Preserve the structure the current character already uses; only render its natural-language content in Spanish.

Do not merely reason in Spanish. Before emitting the final answer, ensure the FINAL VISIBLE RESPONSE itself is in Spanish. Proper names, trademarks, acronyms, and intentionally untranslated fictional terminology may remain unchanged when appropriate.

Never mention or explain this policy.
`.trim();

const FINAL_GATE = `

[FINAL OUTPUT GATE]
Regardless of the language used anywhere above, the complete final visible assistant response MUST be in natural Latin American Spanish. English source text is reference material, not an output-language instruction. Do not describe this as translation and do not make it part of the story.
`.trim();

export function injectLanguagePolicy(messages, enabled = true) {
  if (!enabled) return Array.isArray(messages) ? structuredClone(messages) : [];

  const cloned = Array.isArray(messages) ? structuredClone(messages) : [];
  const firstSystemIndex = cloned.findIndex((m) => m?.role === 'system' && typeof m?.content === 'string');

  if (firstSystemIndex >= 0) {
    const original = cloned[firstSystemIndex].content;
    cloned[firstSystemIndex].content = `${LANGUAGE_POLICY}\n\n--- EXISTING SYSTEM INSTRUCTIONS ---\n${original}\n\n--- END EXISTING SYSTEM INSTRUCTIONS ---\n${FINAL_GATE}`;
  } else {
    cloned.unshift({ role: 'system', content: `${LANGUAGE_POLICY}\n\n${FINAL_GATE}` });
  }

  return cloned;
}

export function buildRewriteMessages(text) {
  return [
    {
      role: 'system',
      content: `You are a lossless localization layer for roleplay text. Rewrite the supplied assistant response into natural Latin American Spanish. Preserve meaning, characterization, emotional intensity, point of view, Markdown, asterisks, quotation marks, line breaks, headings, timestamps, status blocks, labels, and structure. Do not summarize, censor, embellish, continue the scene, explain the task, or add new content. Proper names and intentionally foreign fictional terms may remain unchanged. Output ONLY the rewritten response in Spanish.`,
    },
    {
      role: 'user',
      content: text,
    },
  ];
}

const SPANISH_HINTS = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','que','y','en','a','por','para','con','sin','como','pero','si','no','su','sus','se','es','son','está','están','yo','tú','te','me','mi','mis','lo','le','les','porque','cuando','donde','qué','cómo','más','muy','ya','también','entonces','aunque','ella','él','ellos','ellas','esto','esa','ese','aquí','ahora'
]);
const ENGLISH_HINTS = new Set([
  'the','a','an','and','or','but','if','is','are','was','were','be','been','to','of','in','on','at','for','with','without','as','that','this','these','those','i','you','he','she','they','we','my','your','his','her','their','our','it','not','do','does','did','have','has','had','what','how','when','where','why','then','though','because','from','into','still','just'
]);

export function languageScore(text) {
  const words = String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .match(/[\p{L}ÁÉÍÓÚÜÑáéíóúüñ]+/gu) || [];

  let es = 0;
  let en = 0;
  for (const word of words) {
    if (SPANISH_HINTS.has(word)) es += 1;
    if (ENGLISH_HINTS.has(word)) en += 1;
  }
  if (/[¿¡ñáéíóúü]/i.test(text || '')) es += 2;

  return { es, en, words: words.length };
}

export function shouldRewriteToSpanish(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const { es, en, words } = languageScore(value);
  if (words < 6) return en > es;
  return en >= 3 && en > es * 1.15;
}
