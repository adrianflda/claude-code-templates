/**
 * A small English-vs-Spanish detector for chat messages, built for one question: "did
 * this message talk to the user in English when it should have been Spanish?".
 *
 * It ignores what is legitimately English inside a Spanish message: fenced code, inline
 * code, URLs, paths and identifiers, and blockquotes ("> ..."), which is how to quote an
 * English commit title, PR title or error. It then counts English and Spanish function
 * words (articles, pronouns, prepositions), which carry the language of a sentence
 * whatever its technical vocabulary.
 */

const EN = new Set(`the and is are was were be been being to of in that this it its for with on at by from
you we they i my your our their not have has had will would should can could do does did which what when
where there then than but or if so an as into about before after only also just now here it's don't
isn't i'll i'm i've let's we'll we're you're these those because while how why all any each more some such
been onto until unless whether done`.split(/\s+/));

const ES = new Set(`el la los las de del que y en un una unos unas es son para por con lo se al como pero mas
más ya si sí está esta este esto eso esa ese estos esas hay te tu tú mi yo nos cuando donde dónde porque
también tambien sin sobre entre muy todo todos toda todas hace ser hoy qué que cómo aquí aqui ahora solo
sólo están estan fue era tiene tienen puede pueden hacer le les su sus o ni quedó falta sigue va vamos
voy hecho cada otra otro desde hasta tus mis`.split(/\s+/));

/** Remove everything that is allowed to be English. */
export function prose(text) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/~~~[\s\S]*?(~~~|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .map((l) => l.replace(/\S*[/\\_]\S*/g, ' ').replace(/\b[\w-]+\.[a-z]{1,5}\b/gi, ' '))
    .join('\n');
}

function count(line) {
  const words = line.toLowerCase().match(/[a-záéíóúñü']+/g) || [];
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (EN.has(w)) en++;
    else if (ES.has(w)) es++;
  }
  return { en, es };
}

/**
 * Lines written in English. A line counts when it has at least 3 English function words
 * and at most one Spanish one per three English ones. As a backstop, a message made of many
 * short English lines is reported as a whole.
 */
export function englishLines(text) {
  const out = [];
  let EN_T = 0;
  let ES_T = 0;
  for (const raw of prose(text).split('\n')) {
    const { en, es } = count(raw);
    EN_T += en;
    ES_T += es;
    if (en >= 3 && en >= 3 * es) out.push(raw.trim());
  }
  if (!out.length && EN_T >= 6 && EN_T >= 3 * ES_T) out.push('(the message as a whole is in English)');
  return out;
}
