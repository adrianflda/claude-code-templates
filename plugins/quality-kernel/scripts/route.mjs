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

export function classify(changed, config, proposed, deleted = []) {
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

  // critical-surface.json comes from the BASE REF (immutable), never the worktree or env.
  let config = null;
  if (base && repo) {
    const raw = showAtRef(repo, base, '.quality-kernel/critical-surface.json');
    if (raw !== null) {
      try { config = JSON.parse(raw); }
      catch (e) { opError(`unreadable critical-surface.json at base ${base}: ${e.message}`); }
    }
  }

  emit(classify(changed, config, proposed, deleted));
  process.exit(0);
}
