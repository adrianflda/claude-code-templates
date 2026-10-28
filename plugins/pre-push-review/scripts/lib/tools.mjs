// Deterministic tools: secret scanning and the repo's own checks.
//
// Two trust levels exist and they are kept apart on purpose:
//   - Standalone scanners (gitleaks) run over a SNAPSHOT of the changed files in a temp
//     directory. They execute no repo code, so they are safe on any change, including a fetched
//     pull request.
//   - Repo commands (typecheck, lint, anything in `tools.commands`) execute repo-controlled
//     configuration. They run only when the scope says the head is the developer's own checkout.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { registerCleanup } from './cleanup.mjs';
import { makeRelativizer, PARSER_FNS } from './parsers.mjs';
import { readHeadFile } from './scope.mjs';

const MAX_OUTPUT = 32 * 1024 * 1024;
const TAIL_CHARS = 1500;

/** Run a process to completion with a hard timeout. Never rejects. */
export function exec(file, args, { cwd, timeoutMs, shell = false, env = process.env } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({ code: null, stdout, stderr: e.message, timedOut, spawnError: true, durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: e.message, timedOut, spawnError: true, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut, spawnError: false, durationMs: Date.now() - started });
    });
  });
}

export async function isInstalled(binary) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = await exec(probe, [binary], { timeoutMs: 5000 });
  return r.code === 0 && r.stdout.trim() !== '';
}

/**
 * Write the head version of every changed, readable file into a fresh temp directory.
 * Returns { dir, written, cleanup }.
 */
export function buildSnapshot(scope) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-review-snap-'));
  let written = 0;
  for (const file of scope.files) {
    if (file.status === 'deleted' || file.binary) continue;
    const target = resolve(dir, file.path);
    if (!target.startsWith(dir + sep)) continue; // never write outside the snapshot
    const content = readHeadFile(scope, file.path);
    if (content == null) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written += 1;
  }
  return { dir, written, cleanup: registerCleanup(() => rmSync(dir, { recursive: true, force: true })) };
}

function tail(text) {
  const t = String(text ?? '').trim();
  return t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t;
}

/**
 * Keep the findings that belong to the change. `lines` keeps a finding only on a line the
 * change added; `file` keeps any line of a changed file (a type error caused by an edit often
 * surfaces elsewhere in the same file). Everything else is counted, not reported.
 */
export function filterToChange(findings, byPath, scopeKind) {
  const kept = [];
  let outside = 0;
  for (const f of findings) {
    const file = byPath.get(f.file);
    if (!file) {
      outside += 1;
      continue;
    }
    if (scopeKind === 'file' || f.line == null || file.addedLines.has(f.line)) kept.push(f);
    else outside += 1;
  }
  return { kept, outside };
}

async function runGitleaks({ scope, snapshot, byPath, timeoutMs }) {
  const name = 'gitleaks';
  if (!(await isInstalled('gitleaks'))) return { name, status: 'skipped', reason: 'gitleaks is not installed', findings: [] };
  if (snapshot.written === 0) return { name, status: 'skipped', reason: 'no readable changed files', findings: [] };

  const report = join(snapshot.dir, '..', `gitleaks-${process.pid}-${Date.now()}.sarif`);
  const args = ['dir', snapshot.dir, '--report-format', 'sarif', '--report-path', report, '--no-banner', '--redact', '--exit-code', '0'];
  const repoConfig = join(scope.reviewRoot, '.gitleaks.toml');
  if (existsSync(repoConfig)) args.push('--config', repoConfig);

  const r = await exec('gitleaks', args, { cwd: snapshot.dir, timeoutMs });
  try {
    if (r.timedOut) return { name, status: 'timeout', reason: `timed out after ${timeoutMs}ms`, findings: [], durationMs: r.durationMs };
    if (r.code !== 0 || !existsSync(report)) {
      return { name, status: 'error', reason: tail(r.stderr) || `exit ${r.code}`, findings: [], durationMs: r.durationMs };
    }
    const parsed = PARSER_FNS.sarif(readFileSync(report, 'utf8'), makeRelativizer([snapshot.dir]), { severity: 'critical' });
    const { kept, outside } = filterToChange(parsed, byPath, 'lines');
    return {
      name,
      status: kept.length ? 'findings' : 'ok',
      // gitleaks' own message names the snapshot path, which means nothing to the reader.
      findings: kept.map((f) => ({
        ...f,
        title: `Secret detected (${f.rule ?? 'unknown rule'})`,
        issue: `gitleaks rule "${f.rule ?? 'unknown'}" matched a value on this line, which this change adds. If it is a real credential, rotate it and keep it out of the repository.`,
      })),
      outsideChange: outside,
      durationMs: r.durationMs,
    };
  } catch (e) {
    return { name, status: 'error', reason: `could not parse gitleaks report: ${e.message}`, findings: [], durationMs: r.durationMs };
  } finally {
    rmSync(report, { force: true });
  }
}

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'tsc'];
const LINT_SCRIPTS = ['lint'];

/** Repo checks inferred from package.json, used when `tools.commands` is empty. */
export function detectCommands(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(join(root, 'node_modules'))) return [];
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    return [];
  }
  const commands = [];
  const typecheck = TYPECHECK_SCRIPTS.find((s) => typeof scripts[s] === 'string');
  if (typecheck) commands.push({ name: 'typecheck', run: `npm run --silent ${typecheck}`, parser: 'tsc', scope: 'file', detected: true });
  const lint = LINT_SCRIPTS.find((s) => typeof scripts[s] === 'string');
  if (lint) commands.push({ name: 'lint', run: `npm run --silent ${lint}`, parser: 'eslint-stylish', scope: 'lines', detected: true });
  return commands;
}

async function runCommand(command, { scope, byPath, timeoutMs }) {
  const name = command.name;
  const parser = command.parser ?? 'exit-code';
  const r = await exec(command.run, [], { cwd: scope.reviewRoot, timeoutMs: command.timeoutMs ?? timeoutMs, shell: true });
  if (r.timedOut) return { name, status: 'timeout', reason: `timed out after ${command.timeoutMs ?? timeoutMs}ms`, findings: [], durationMs: r.durationMs };
  if (r.spawnError) return { name, status: 'error', reason: tail(r.stderr), findings: [], durationMs: r.durationMs };

  let parsed = [];
  try {
    parsed = PARSER_FNS[parser](parser === 'sarif' || parser === 'eslint-json' ? r.stdout : `${r.stdout}\n${r.stderr}`, makeRelativizer([scope.reviewRoot]));
  } catch (e) {
    // Output that cannot be parsed is reported as such. Treating it as "no findings" would
    // turn a broken tool into a silent pass.
    return { name, status: 'error', reason: `could not parse ${parser} output: ${e.message}`, outputTail: tail(r.stdout || r.stderr), findings: [], durationMs: r.durationMs };
  }

  const { kept, outside } = filterToChange(parsed, byPath, command.scope ?? (parser === 'tsc' ? 'file' : 'lines'));
  let status = 'ok';
  if (kept.length) status = 'findings';
  else if (r.code !== 0) status = parsed.length ? 'ok' : 'failed';

  return {
    name,
    status,
    exitCode: r.code,
    required: Boolean(command.required),
    findings: kept,
    outsideChange: outside,
    ...(status === 'failed' ? { reason: `exited ${r.code} with no parseable findings`, outputTail: tail(r.stderr || r.stdout) } : {}),
    durationMs: r.durationMs,
  };
}

/**
 * Run every applicable deterministic tool. Returns [{ name, status, findings, ... }], where
 * status is ok | findings | failed | error | timeout | skipped.
 */
export async function runTools({ scope, config, byPath, allowRepoCommands = true }) {
  const results = [];
  const timeoutMs = config.tools.timeoutMs;
  const snapshot = buildSnapshot(scope);
  try {
    const jobs = [];
    if (config.tools.gitleaks) jobs.push(runGitleaks({ scope, snapshot, byPath, timeoutMs }));

    const commands = config.tools.commands.length
      ? config.tools.commands
      : config.tools.autoDetect
        ? detectCommands(scope.reviewRoot)
        : [];
    for (const command of commands) {
      if (!scope.repoCommandsAllowed) {
        results.push({ name: command.name, status: 'skipped', reason: 'repo commands are not run against code fetched from a pull request', findings: [] });
      } else if (!allowRepoCommands) {
        results.push({ name: command.name, status: 'skipped', reason: 'repo commands are disabled for this run', findings: [] });
      } else if (scope.dirtyPaths.length > 0) {
        // Repo commands read the working tree. When it differs from what is under review,
        // their line numbers would point at code that is not part of the change.
        results.push({
          name: command.name,
          status: 'skipped',
          reason: `the working tree differs from the reviewed version of ${scope.dirtyPaths.length} changed file(s)`,
          findings: [],
        });
      } else {
        jobs.push(runCommand(command, { scope, byPath, timeoutMs }));
      }
    }
    results.push(...(await Promise.all(jobs)));
  } finally {
    snapshot.cleanup();
  }
  return results;
}
