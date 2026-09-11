#!/usr/bin/env node
// Deterministic risk/tier router — M1 (v2: commit-anchored, base-authoritative).
// Spec: docs/agentic-harness/spec-m1-route.v1.md · Rework rationale: validation-panel.v1.md
//
// Classifies a change's blast-radius by MECHANISM (Constitution P4). LLM may raise the tier,
// never lower the floor. Fail-safe: no config => critical (P5).
//
// v2 hardening (from the independent panel, validation-panel.v1.md §2):
//  - The changeset is `git diff base..HEAD` between two COMMITTED refs (never base-vs-worktree),
//    parsed with `-z` so rename/copy/type-change and non-ASCII paths are handled exactly.
//    A rename's OLD path counts as a deletion (so "delete a test" cannot be dodged by `git mv`).
//  - `critical-surface.json` is read from the BASE REF (immutable to the change), never from the
//    mutable worktree or an env var — closes the "drop an untracked permissive config" bypass.
//  - `.quality-kernel/**` is ALWAYS critical; deleting a test is ALWAYS critical; EDITING a test
//    is never trivial (floor >= standard) — you cannot call a coverage change "trivial".
//  - Requires --base; a git failure or unverifiable ref is an operational error (fail-closed).
//
// Usage: route.mjs --repo <dir> --base <ref> [--head <ref>] [--changed a,b] [--deleted c] [--proposed tier]
// Exit:  0 = classified (incl. critical) · 2 = operational error (fail-closed critical)

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TIERS = { trivial: 0, standard: 1, critical: 2 };
const NAME = ['trivial', 'standard', 'critical'];
const ALWAYS_CRITICAL_GLOBS = ['**/.quality-kernel/**'];
// Shared test-file recognition (route + referee). Broad on purpose: any common convention counts as
// a test so it is (a) forced non-trivial when edited, (b) critical when deleted, (c) never overlaid
// from head. Missing a convention is a hole (panel finding C), so this errs toward inclusion.
export const TEST_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/*.tests.*', '**/__tests__/**',
  '**/*_test.*', '**/test_*.*', '**/*-test.*', '**/test-*.*', '**/*_spec.*', '**/*Spec.*',
  '**/test/**', '**/tests/**', '**/spec/**',
];

function emit(v) { process.stdout.write(JSON.stringify(v) + '\n'); }
function opError(reason) { emit({ tier: 'critical', tierFloor: 'critical', requiresBreaker: true, error: reason }); process.exit(2); }

// Minimal glob -> RegExp (case-insensitive). Supports **, * (not across /), ?. No deps.
export function globToRegExp(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
      else { re += '.*'; i += 2; }
    } else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if ('\\^$.|+()[]{}'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  return new RegExp(re + '$', 'i');
}
const matchesAny = (globs, path) => globs.some((g) => globToRegExp(g).test(path));
const isTest = (p) => matchesAny(TEST_GLOBS, p);
// The tool's OWN append-only audit ledgers under .quality-kernel/ are runtime artifacts, not config
// or code the gate reads — never let them trip the gate if a user commits them (gitignore is advised).
// ONLY these exact generated names are tool-owned: a wildcard here would exempt any project-specific
// .quality-kernel/*.jsonl (contract or data) from the always-critical surface, and would let a
// force-added attacker file ride the same bypass.
export const TOOL_LEDGERS = new Set(['evidence-ledger.jsonl', 'run-ledger.jsonl']);
export const isLedger = (p) => {
  const m = /(^|\/)\.quality-kernel\/([^/]+)$/.exec(p);
  return !!m && TOOL_LEDGERS.has(m[2]);
};

// A parseable config is not a valid one. `criticalGlobs`/`safeGlobs` must be arrays of strings:
// spreading a plain string would explode it into single characters (so `auth/**` silently stops
// matching and a critical change is classified below critical), and a non-array safeGlobs crashes
// classification. Returns null when the shape is fine, else the reason it is not.
export function configError(config) {
  if (config === null || config === undefined) return null;
  if (typeof config !== 'object' || Array.isArray(config)) return 'critical-surface.json must be a JSON object';
  for (const field of ['criticalGlobs', 'safeGlobs']) {
    const v = config[field];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return `${field} must be an array of strings`;
    if (!v.every((g) => typeof g === 'string')) return `${field} must contain only strings`;
  }
  return null;
}

export function classify(changed, config, proposed, deleted = []) {
  // Fail-safe (P5): an invalid config is treated as NO config -> critical floor, never spread.
  const invalidConfig = configError(config);
  if (invalidConfig) config = null;
  const criticalGlobs = [...ALWAYS_CRITICAL_GLOBS, ...((config && config.criticalGlobs) || [])];
  const safeGlobs = (config && config.safeGlobs) || [];
  const deletedTests = deleted.filter(isTest);
  const changedTests = changed.filter(isTest);
  const criticalFiles = changed.filter((p) => matchesAny(criticalGlobs, p));
  const deletedCritical = deleted.filter((p) => matchesAny(criticalGlobs, p));

  const floorName = (() => {
    if (deletedTests.length) return 'critical';               // removing tests is never trivial
    if (!changed.length && !deleted.length) return 'trivial';  // truly nothing changed
    if (!config) return 'critical';                            // fail-safe (P5)
    if (criticalFiles.length || deletedCritical.length) return 'critical';
    // A change that edits/adds a test is a CONTRACT change: the referee will run the head version
    // (so legitimate updates work), so the router forces human review (Constitution: the human owns
    // the contract). This is what makes "neutering a test" visible-and-gated rather than silent.
    if (changedTests.length) return 'critical';
    if (changed.every((p) => matchesAny(safeGlobs, p)) && deleted.every((p) => matchesAny(safeGlobs, p))) return 'trivial';
    return 'standard';
  })();

  const prop = proposed && proposed in TIERS ? TIERS[proposed] : 0;
  const tierName = NAME[Math.max(TIERS[floorName], prop)];
  return {
    tierFloor: floorName,
    tier: tierName,
    requiresBreaker: tierName === 'critical',
    criticalFiles: [...new Set([...criticalFiles, ...deletedCritical])],
    deletedTests,
    changedTests,
    reason:
      deletedTests.length ? `test file(s) removed: ${deletedTests.join(', ')}`
        : invalidConfig ? `invalid critical-surface.json (${invalidConfig}) -> fail-safe critical`
          : floorName === 'critical' && !config ? 'no critical-surface config -> fail-safe critical'
          : changedTests.length ? `test file(s) modified (contract change -> human review): ${changedTests.join(', ')}`
            : floorName === 'critical' ? `critical surface touched: ${[...criticalFiles, ...deletedCritical].join(', ')}`
              : floorName === 'trivial' ? 'all changed paths are on the safe surface'
                : 'no critical paths, but not all safe',
  };
}

// Read a file at a committed ref, or null if absent/unreadable. Never touches the worktree.
export function showAtRef(repo, ref, path) {
  const r = spawnSync('git', ['-C', repo, 'show', `${ref}:${path}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

// Parse `git diff -z --name-status -M base..head` into {changed, deleted}. A rename/copy's OLD
// path is a deletion; a type-change (T) is delete+add; everything else's target path is a change.
export function parseDiffZ(buf) {
  const changed = [];
  const deleted = [];
  const parts = buf.split('\0');
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) { i++; continue; }
    const code = status[0];
    if (code === 'R' || code === 'C') {           // status \0 old \0 new
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      i += 3;
      if (code === 'R' && oldPath) deleted.push(oldPath); // renamed-away path is gone
      if (newPath) changed.push(newPath);
    } else {                                       // status \0 path
      const path = parts[i + 1];
      i += 2;
      if (!path) continue;
      if (code === 'D') deleted.push(path);
      else if (code === 'T') { deleted.push(path); changed.push(path); }
      else changed.push(path);
    }
  }
  return { changed, deleted };
}

// --- CLI ---
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  let repo = null, base = null, head = 'HEAD', changedArg = null, deletedArg = null, proposed = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = args[++i];
    else if (args[i] === '--base') base = args[++i];
    else if (args[i] === '--head') head = args[++i];
    else if (args[i] === '--changed') changedArg = args[++i];
    else if (args[i] === '--deleted') deletedArg = args[++i];
    else if (args[i] === '--proposed') proposed = args[++i];
  }

  const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  let changed = [];
  let deleted = [];
  if (changedArg !== null || deletedArg !== null) {
    changed = splitList(changedArg);
    deleted = splitList(deletedArg);
  } else {
    if (!repo) opError('need --changed <files> or --repo <dir> --base <ref>');
    if (!base) opError('need --base <ref> for a git-derived changeset (or pass --changed explicitly)');
    // Both endpoints must be verifiable committed refs — never the worktree.
    for (const ref of [base, head]) {
      if (spawnSync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).status !== 0) {
        opError(`unverifiable ref "${ref}" in ${repo} (need committed base..head)`);
      }
    }
    const d = spawnSync('git', ['-C', repo, 'diff', '-z', '--name-status', '-M', `${base}..${head}`], { encoding: 'utf8' });
    if (d.status !== 0) opError(`git diff failed in ${repo}: ${(d.stderr || '').trim() || 'non-zero exit'}`);
    ({ changed, deleted } = parseDiffZ(d.stdout));
  }

  // ignore the tool's own audit ledgers (see isLedger)
  changed = changed.filter((p) => !isLedger(p));
  deleted = deleted.filter((p) => !isLedger(p));

  // critical-surface.json comes from the BASE REF (immutable), never the worktree or env.
  let config = null;
  if (base && repo) {
    const raw = showAtRef(repo, base, '.quality-kernel/critical-surface.json');
    if (raw !== null) {
      try { config = JSON.parse(raw); }
      catch (e) { opError(`unreadable critical-surface.json at base ${base}: ${e.message}`); }
      // Parseable is not valid: a wrong-typed criticalGlobs/safeGlobs would silently stop matching.
      const bad = configError(config);
      if (bad) opError(`invalid critical-surface.json at base ${base}: ${bad}`);
    }
  }

  emit(classify(changed, config, proposed, deleted));
  process.exit(0);
}
