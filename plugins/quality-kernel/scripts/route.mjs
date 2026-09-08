#!/usr/bin/env node
// Deterministic risk/tier router — M1.
// Spec: docs/agentic-harness/spec-m1-route.v1.md · Plan: plan-m1-route.v1.md
//
// Classifies a change's blast-radius by MECHANISM (not model judgment): a change touching the
// critical surface can never be routed down a cheap/autonomous lane. LLM may raise the tier,
// never lower the floor (Constitution P4). Fail-safe: no config => critical (P5).
//
// Usage: route.mjs --repo <dir> [--base <ref>] [--changed a,b,c] [--proposed trivial|standard|critical]
// Exit:  0 = classified (incl. critical) · 2 = operational error (fail-closed)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TIERS = { trivial: 0, standard: 1, critical: 2 };
const NAME = ['trivial', 'standard', 'critical'];

function emit(v) { process.stdout.write(JSON.stringify(v) + '\n'); }
function opError(reason) { emit({ tier: 'critical', tierFloor: 'critical', requiresBreaker: true, error: reason }); process.exit(2); }

// Minimal glob -> RegExp (case-insensitive). Supports **, * (not across /), ?. No deps.
export function globToRegExp(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }   // **/ = zero-or-more dirs
      else { re += '.*'; i += 2; }
    } else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if ('\\^$.|+()[]{}'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  return new RegExp(re + '$', 'i');
}
const matchesAny = (globs, path) => globs.some((g) => globToRegExp(g).test(path));

export function classify(changed, config, proposed) {
  const floorName = (() => {
    if (!changed.length) return 'trivial';
    if (!config) return 'critical'; // fail-safe (Constitution P5)
    const critical = config.criticalGlobs || [];
    const safe = config.safeGlobs || [];
    const criticalFiles = changed.filter((p) => matchesAny(critical, p));
    if (criticalFiles.length) return 'critical';
    if (changed.every((p) => matchesAny(safe, p))) return 'trivial';
    return 'standard';
  })();
  const floor = TIERS[floorName];
  const prop = proposed && proposed in TIERS ? TIERS[proposed] : 0;
  const tierName = NAME[Math.max(floor, prop)];
  const criticalFiles = config
    ? changed.filter((p) => matchesAny(config.criticalGlobs || [], p))
    : (changed.length ? [...changed] : []);
  return {
    tierFloor: floorName,
    tier: tierName,
    requiresBreaker: tierName === 'critical',
    criticalFiles,
    reason:
      floorName === 'critical' && !config ? 'no critical-surface config -> fail-safe critical'
        : floorName === 'critical' ? `critical surface touched: ${criticalFiles.join(', ')}`
          : floorName === 'trivial' ? 'all changed paths are on the safe surface'
            : 'no critical paths, but not all safe',
  };
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let repo = null, base = null, changedArg = null, proposed = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = args[++i];
    else if (args[i] === '--base') base = args[++i];
    else if (args[i] === '--changed') changedArg = args[++i];
    else if (args[i] === '--proposed') proposed = args[++i];
  }

  let changed;
  if (changedArg !== null) {
    changed = changedArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    if (!repo) opError('need --changed <files> or --repo <dir> [--base <ref>]');
    const ref = base || 'HEAD';
    const d = spawnSync('git', ['-C', repo, 'diff', '--name-only', `${ref}...HEAD`], { encoding: 'utf8' });
    if (d.status !== 0) opError(`git diff failed in ${repo}: ${(d.stderr || '').trim() || 'non-zero exit'}`);
    changed = d.stdout.split('\n').filter(Boolean);
  }

  let config = null;
  const cfgPath = repo ? join(repo, '.quality-kernel', 'critical-surface.json') : null;
  const envCfg = process.env.QK_CRITICAL_SURFACE; // lets --changed tests point at a config
  const readCfg = envCfg && existsSync(envCfg) ? envCfg : (cfgPath && existsSync(cfgPath) ? cfgPath : null);
  if (readCfg) {
    try { config = JSON.parse(readFileSync(readCfg, 'utf8')); }
    catch (e) { opError(`unreadable critical-surface.json: ${e.message}`); }
  }

  emit(classify(changed, config, proposed));
  process.exit(0);
}
