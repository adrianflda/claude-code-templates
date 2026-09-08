#!/usr/bin/env node
// Deterministic risk/tier router — M1 (hardened after the specialist red-team).
// Spec: docs/agentic-harness/spec-m1-route.v1.md · Plan: plan-m1-route.v1.md
//
// Classifies a change's blast-radius by MECHANISM (Constitution P4). LLM may raise the tier,
// never lower the floor. Fail-safe: no config => critical (P5).
//
// Hardening (from review-m0m1):
//  - `.quality-kernel/**` is ALWAYS critical (hardcoded) so weakening the gate's own config
//    can never be a cheap lane.
//  - Deleting a test file is ALWAYS critical (the "delete the red test to go green" attack).
//  - The git path requires --base and diffs base-vs-worktree; no --base => operational error
//    (fail-closed), never an empty diff silently downgraded to trivial.
//
// Usage: route.mjs --repo <dir> --base <ref> [--changed a,b] [--deleted c] [--proposed tier]
// Exit:  0 = classified (incl. critical) · 2 = operational error (fail-closed critical)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TIERS = { trivial: 0, standard: 1, critical: 2 };
const NAME = ['trivial', 'standard', 'critical'];
const ALWAYS_CRITICAL_GLOBS = ['**/.quality-kernel/**'];
const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*_test.*', '**/test_*.*'];

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
  const criticalFiles = changed.filter((p) => matchesAny(criticalGlobs, p));
  const deletedCritical = deleted.filter((p) => matchesAny(criticalGlobs, p));

  const floorName = (() => {
    if (deletedTests.length) return 'critical';               // removing tests is never trivial
    if (!changed.length && !deleted.length) return 'trivial';  // truly nothing changed
    if (!config) return 'critical';                            // fail-safe (P5)
    if (criticalFiles.length || deletedCritical.length) return 'critical';
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
    reason:
      deletedTests.length ? `test file(s) removed: ${deletedTests.join(', ')}`
        : floorName === 'critical' && !config ? 'no critical-surface config -> fail-safe critical'
          : floorName === 'critical' ? `critical surface touched: ${[...criticalFiles, ...deletedCritical].join(', ')}`
            : floorName === 'trivial' ? 'all changed paths are on the safe surface'
              : 'no critical paths, but not all safe',
  };
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let repo = null, base = null, changedArg = null, deletedArg = null, proposed = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = args[++i];
    else if (args[i] === '--base') base = args[++i];
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
    const d = spawnSync('git', ['-C', repo, 'diff', '--name-status', base], { encoding: 'utf8' });
    if (d.status !== 0) opError(`git diff failed in ${repo}: ${(d.stderr || '').trim() || 'non-zero exit'}`);
    for (const line of d.stdout.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const status = parts[0];
      const path = parts[parts.length - 1]; // rename gives old\tnew; take the new path
      if (!path) continue;
      if (status.startsWith('D')) deleted.push(path);
      else changed.push(path);
    }
  }

  let config = null;
  const cfgPath = repo ? join(repo, '.quality-kernel', 'critical-surface.json') : null;
  const envCfg = process.env.QK_CRITICAL_SURFACE;
  const readCfg = envCfg && existsSync(envCfg) ? envCfg : (cfgPath && existsSync(cfgPath) ? cfgPath : null);
  if (readCfg) {
    try { config = JSON.parse(readFileSync(readCfg, 'utf8')); }
    catch (e) { opError(`unreadable critical-surface.json: ${e.message}`); }
  }

  emit(classify(changed, config, proposed, deleted));
  process.exit(0);
}
