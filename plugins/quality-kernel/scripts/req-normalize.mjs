#!/usr/bin/env node
// Stage A (merge/dedupe/normalize) — requirements-coverage skill.
// The extractor analysts (parallel, one per document) each emit candidate requirements; the PM
// concatenates them and this DETERMINISTIC step turns them into one canonical, deduplicated set.
//
// Input (stdin or --in <file>): JSON array of candidates
//   [{ text, source:{doc,location?}, category?, priority? }, ...]
// Output: canonical requirements JSON
//   [{ id:"REQ-001", text, sources:[{doc,location}], category, priority }, ...]
// Dedup key = normalized text (lowercase · collapsed whitespace · trailing punctuation stripped);
// duplicates merge their sources. Stable order (by first source doc, then text) → stable ids.

import { readFileSync } from 'node:fs';

const normKey = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').replace(/[.;:,\s]+$/, '').trim();

export function normalize(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    if (!c || !c.text) continue;
    const k = normKey(c.text);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, { text: String(c.text).trim(), sources: [], category: c.category || 'general', priority: c.priority || 'normal' });
    const e = byKey.get(k);
    if (c.source) e.sources.push(c.source);
    if (c.priority === 'high') e.priority = 'high'; // any analyst flagging high wins
  }
  const items = [...byKey.values()].sort((a, b) =>
    (a.sources[0]?.doc || '').localeCompare(b.sources[0]?.doc || '') || a.text.localeCompare(b.text));
  return items.map((e, i) => ({ id: `REQ-${String(i + 1).padStart(3, '0')}`, ...e }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inIdx = process.argv.indexOf('--in');
  let raw; try { raw = readFileSync(inIdx >= 0 ? process.argv[inIdx + 1] : 0, 'utf8'); } catch (e) { process.stderr.write(`cannot read input: ${e.message}\n`); process.exit(2); }
  let cands; try { cands = JSON.parse(raw); } catch { process.stderr.write('input must be JSON\n'); process.exit(2); }
  if (!Array.isArray(cands)) { process.stderr.write('input must be a JSON array of candidates\n'); process.exit(2); }
  process.stdout.write(JSON.stringify(normalize(cands), null, 2) + '\n');
}
