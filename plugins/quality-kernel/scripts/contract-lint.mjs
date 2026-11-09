#!/usr/bin/env node
// Contract completeness lint — M2 (plan-with-teeth). Spec: docs/agentic-harness/spec-m2-plan-qa.v1.md
//
// The Contract is two coupled files: a human-facing `<id>.md` (an `## Invariants` table) and a
// machine-checkable `<id>.test.mjs` (one assertion per invariant, qa-paradigms P4). This proves they
// stay in lockstep — every invariant has an assertion and every assertion cites an invariant — so the
// plan's "done" is a mechanism, not prose. NO invariant without a check; NO check without an invariant.
//
// Usage: contract-lint.mjs --contract <id>.md --acceptance <id>.test.mjs
// Exit:  0 = in lockstep · 1 = orphan(s) · 2 = operational error

import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './is-main.mjs';
import { scanSections } from './contract-sections.mjs';

// EARS-H8: id tokens referenced by the acceptance suite. Generalized from the literal `INV-` prefix
// to any uppercase-led id (letters/digits, hyphen, letters/digits/hyphens — EARS-H4's grammar,
// anchored on a leading capital) so a contract's real ids (`EO-0`, `EO-6`) are found here too, while
// staying narrow enough not to mistake an ordinary lowercase kebab-case source token (e.g.
// `manifest-v1`) for a declared id — every id this contract's template produces starts uppercase.
const ID_RE = /\b[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;

// Invariant ids DECLARED in the contract: rows of the Invariants table, using the SAME
// heading-matching + table-row parsing as breaker-invoke.mjs/gstack-breaker.mjs (contract-sections.mjs,
// EARS-H1/H2/H2b/H3/H4/H4b/H5) — EARS-H8, so a numbered/parenthetical heading and non-INV- ids
// (`EO-0`, `**EO-6 (re-run)**`) are no longer silently read as "no invariants declared".
export function contractIds(md) {
  return new Set(scanSections(md).invariants.map((i) => i.id));
}
// Strip // line and /* block */ comments while preserving string/template literals, so a URL such as
// 'http://x' inside a test name is not mistaken for a comment. Regex literals are not tracked; the
// approximation only affects where an id is *found*, never correctness of the lockstep rule itself.
export function stripComments(src) {
  let out = '', i = 0, state = 'code';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }   // escape inside a string
    if (c === state) { state = 'code'; out += c; i++; continue; } // closing quote
    out += c; i++;
  }
  return out;
}

// Invariant ids REFERENCED by the acceptance suite, read from EXECUTABLE source only (test names,
// assertion messages, identifiers). Comments are stripped first: a bare `// INV-A` is documentation,
// not a check, and counting it would let a file satisfy the lockstep with no assertion at all —
// exactly the guarantee ("one assertion per invariant") this lint exists to prove.
export function acceptanceIds(src) {
  return new Set(stripComments(src).match(ID_RE) || []);
}
// The id token before its first hyphen, e.g. "INV-1" -> "INV", "EO-6" -> "EO".
function idPrefix(id) { return id.slice(0, id.indexOf('-')); }

export function diff(md, src) {
  const declared = contractIds(md);
  // ID_RE (above) is deliberately wide — any uppercase-led hyphenated token — so EARS-H4's
  // non-`INV-`-prefixed ids (EO-0, EO-6, ...) are found in acceptance source too. That same
  // width also matches ordinary prose/code tokens that are not ids at all (`Content-Type`,
  // `UTF-8`, `X-Forwarded-For`). Narrow here, against THIS contract's own declared ids: an
  // acceptance token only counts as a referenced id if its prefix matches the prefix of an id
  // this contract actually declares — everything else is prose, not a reference, and must not
  // become a spurious orphanAssertion.
  const declaredPrefixes = new Set([...declared].map(idPrefix));
  // Review item B: the declared families alone would hide a cross-family orphan — a contract that
  // migrated from the legacy `INV-` ids to the specifier's own ids (e.g. `EO-`) can still carry a
  // stale `INV-1` reference in its acceptance suite; declaredPrefixes = {EO} alone would silently
  // drop that token before orphanAssertion ever saw it. Accept the declared families UNION the
  // historical default `INV`, so a stale cross-family id is still flagged as an orphan, while a
  // plain `INV-` contract (every id already in declaredPrefixes) and ordinary prose outside both
  // families behave exactly as before.
  const acceptedPrefixes = new Set([...declaredPrefixes, 'INV']);
  const checked = new Set([...acceptanceIds(src)].filter((id) => acceptedPrefixes.has(idPrefix(id))));
  const missingAssertion = [...declared].filter((id) => !checked.has(id));  // invariant with no check
  const orphanAssertion = [...checked].filter((id) => !declared.has(id));   // check with no invariant
  return { declared: [...declared], checked: [...checked], missingAssertion, orphanAssertion };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let contract = null, acceptance = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contract') contract = args[++i];
    else if (args[i] === '--acceptance') acceptance = args[++i];
  }
  const fail = (reason) => { process.stdout.write(JSON.stringify({ ok: false, error: reason }) + '\n'); process.exit(2); };
  if (!contract || !acceptance) fail('need --contract <md> --acceptance <testfile>');
  if (!existsSync(contract) || !existsSync(acceptance)) fail('contract or acceptance file not found');

  const d = diff(readFileSync(contract, 'utf8'), readFileSync(acceptance, 'utf8'));
  if (!d.declared.length) fail('no invariants declared in the contract (## Invariants table)');
  const ok = d.missingAssertion.length === 0 && d.orphanAssertion.length === 0;
  process.stdout.write(JSON.stringify({ ok, ...d }) + '\n');
  process.exit(ok ? 0 : 1);
}
