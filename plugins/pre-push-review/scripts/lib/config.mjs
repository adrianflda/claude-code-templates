// Configuration: built-in defaults, overlaid by the repo's committed `.pre-push-review.json`,
// overlaid by environment variables. Invalid values are reported, never silently coerced —
// a gate that quietly falls back to a default is a gate nobody can reason about.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = '.pre-push-review.json';
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const ROLE_KEYS = [
  'security',
  'correctness',
  'reliability',
  'performance',
  'tests',
  'maintainability',
];
export const PARSERS = ['sarif', 'tsc', 'eslint-json', 'eslint-stylish', 'gnu', 'exit-code'];

export const DEFAULTS = Object.freeze({
  profile: 'full', // full = one specialist per role; quick = a single generalist
  roles: ROLE_KEYS,
  models: { reviewer: 'sonnet', verifier: 'opus', summary: 'haiku' },
  blockOn: 'critical',
  concurrency: 3,
  timeoutMs: 420_000,
  maxBudgetUsd: 2,
  inlineDiffLines: 4000,
  guidelineChars: 16_000,
  verify: true,
  summary: true,
  required: false, // true = fail (exit 2) when no reviewer could run
  exclude: [
    '*.lock',
    '*-lock.json',
    '*-lock.yaml',
    '*.min.js',
    '*.min.css',
    '*.map',
    '**/__snapshots__/**',
    'dist/**',
    'build/**',
    'node_modules/**',
    'vendor/**',
  ],
  pathInstructions: [],
  tools: {
    autoDetect: true,
    gitleaks: true,
    timeoutMs: 240_000,
    commands: [],
  },
  gate: {
    enabled: true,
    repoCommands: false, // repo lint/typecheck usually already run in husky or CI
    summary: false,
  },
});

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function stringList(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
}

/** Returns a list of human-readable problems; empty means the config is usable. */
export function validateConfig(cfg) {
  const errors = [];
  if (!['full', 'quick'].includes(cfg.profile)) errors.push('profile must be "full" or "quick"');
  if (!stringList(cfg.roles) || cfg.roles.length === 0) errors.push('roles must be a non-empty list');
  else {
    const unknown = cfg.roles.filter((r) => !ROLE_KEYS.includes(r));
    if (unknown.length) errors.push(`unknown role(s): ${unknown.join(', ')} (known: ${ROLE_KEYS.join(', ')})`);
  }
  for (const k of ['reviewer', 'verifier', 'summary']) {
    if (typeof cfg.models?.[k] !== 'string' || cfg.models[k].trim() === '')
      errors.push(`models.${k} must be a model name`);
  }
  if (!['critical', 'high'].includes(cfg.blockOn)) errors.push('blockOn must be "critical" or "high"');
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 12)
    errors.push('concurrency must be an integer from 1 to 12');
  if (!positive(cfg.timeoutMs)) errors.push('timeoutMs must be a positive number');
  if (cfg.maxBudgetUsd !== null && !positive(cfg.maxBudgetUsd))
    errors.push('maxBudgetUsd must be a positive number or null');
  if (!Number.isInteger(cfg.inlineDiffLines) || cfg.inlineDiffLines < 0)
    errors.push('inlineDiffLines must be a non-negative integer');
  if (!positive(cfg.guidelineChars)) errors.push('guidelineChars must be a positive number');
  for (const k of ['verify', 'summary', 'required']) {
    if (typeof cfg[k] !== 'boolean') errors.push(`${k} must be true or false`);
  }
  if (!Array.isArray(cfg.exclude) || !cfg.exclude.every((s) => typeof s === 'string'))
    errors.push('exclude must be a list of glob patterns');

  if (!Array.isArray(cfg.pathInstructions)) errors.push('pathInstructions must be a list');
  else {
    cfg.pathInstructions.forEach((p, i) => {
      if (!isObject(p) || !stringList(p.paths) || typeof p.instructions !== 'string' || !p.instructions.trim())
        errors.push(`pathInstructions[${i}] needs "paths" (list of globs) and "instructions" (text)`);
    });
  }

  if (!isObject(cfg.tools)) errors.push('tools must be an object');
  else {
    if (typeof cfg.tools.autoDetect !== 'boolean') errors.push('tools.autoDetect must be true or false');
    if (typeof cfg.tools.gitleaks !== 'boolean') errors.push('tools.gitleaks must be true or false');
    if (!positive(cfg.tools.timeoutMs)) errors.push('tools.timeoutMs must be a positive number');
    if (!Array.isArray(cfg.tools.commands)) errors.push('tools.commands must be a list');
    else {
      cfg.tools.commands.forEach((c, i) => {
        if (!isObject(c) || typeof c.name !== 'string' || !c.name.trim() || typeof c.run !== 'string' || !c.run.trim())
          errors.push(`tools.commands[${i}] needs "name" and "run"`);
        else if (!PARSERS.includes(c.parser ?? 'exit-code'))
          errors.push(`tools.commands[${i}].parser must be one of ${PARSERS.join(', ')}`);
      });
    }
  }

  if (!isObject(cfg.gate)) errors.push('gate must be an object');
  else {
    for (const k of ['enabled', 'repoCommands', 'summary']) {
      if (typeof cfg.gate[k] !== 'boolean') errors.push(`gate.${k} must be true or false`);
    }
  }
  return errors;
}

/** PREPUSH_REVIEW_<name>, falling back to the AI_REVIEW_<name> knob the v1 panel reads. */
function envValue(env, name) {
  return env[`PREPUSH_REVIEW_${name}`] || env[`AI_REVIEW_${name}`] || null;
}

function envOverrides(env) {
  const over = {};
  const models = {};
  if (envValue(env, 'MODEL')) models.reviewer = envValue(env, 'MODEL');
  if (envValue(env, 'VERIFIER_MODEL')) models.verifier = envValue(env, 'VERIFIER_MODEL');
  if (envValue(env, 'SUMMARY_MODEL')) models.summary = envValue(env, 'SUMMARY_MODEL');
  if (Object.keys(models).length) over.models = models;
  if (envValue(env, 'BLOCK_ON')) over.blockOn = envValue(env, 'BLOCK_ON').toLowerCase();
  if (envValue(env, 'PROFILE')) over.profile = envValue(env, 'PROFILE').toLowerCase();
  if (envValue(env, 'TIMEOUT_MS')) over.timeoutMs = Number(envValue(env, 'TIMEOUT_MS'));
  if (envValue(env, 'CONCURRENCY')) over.concurrency = Number(envValue(env, 'CONCURRENCY'));
  if (envValue(env, 'REQUIRED')) over.required = envValue(env, 'REQUIRED') === '1';
  return over;
}

/**
 * Load the effective config for `root`. Returns { config, source, errors }. When the repo file
 * is unreadable or invalid, `errors` is non-empty and the caller decides whether to stop.
 */
export function loadConfig(root, env = process.env) {
  const errors = [];
  let fileConfig = {};
  let source = 'defaults';
  const path = root ? join(root, CONFIG_FILE) : null;

  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObject(parsed)) errors.push(`${CONFIG_FILE} must contain a JSON object`);
      else {
        fileConfig = parsed;
        source = CONFIG_FILE;
      }
    } catch (e) {
      errors.push(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
    }
  }

  const known = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(fileConfig)) {
    if (!known.has(k) && k !== '$schema') errors.push(`${CONFIG_FILE}: unknown key "${k}"`);
  }

  const config = merge(merge(DEFAULTS, fileConfig), envOverrides(env));
  delete config.$schema;
  errors.push(...validateConfig(config));
  return { config, source, errors };
}
