// Parsers that turn the output of deterministic tools into raw findings
// ({ severity, file, line, endLine, title, issue, rule }). They are pure functions of the tool
// output, so each one is tested against captured output rather than against a live binary.

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath } from './glob.mjs';

function real(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Build a function that maps a path printed by a tool to a repo-relative path. Tools print
 * absolute paths, file:// URIs or paths relative to where they ran; `baseDirs` lists the
 * directories those may be rooted at (the repo root, a snapshot directory).
 */
export function makeRelativizer(baseDirs) {
  const bases = [...new Set(baseDirs.filter(Boolean).flatMap((d) => [d, real(d)]))];
  return (raw) => {
    let p = String(raw ?? '').trim();
    if (!p) return null;
    if (p.startsWith('file://')) {
      try {
        p = fileURLToPath(p);
      } catch {
        return null;
      }
    }
    if (!isAbsolute(p)) return normalizePath(p);
    for (const base of bases) {
      const rel = relative(base, p);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return normalizePath(rel.split(sep).join('/'));
    }
    // An absolute path outside every base cannot belong to the change.
    return null;
  };
}

function sarifSeverity(level, securitySeverity) {
  const score = Number(securitySeverity);
  if (Number.isFinite(score)) {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
  }
  if (level === 'error') return 'high';
  if (level === 'note' || level === 'none') return 'low';
  return 'medium';
}

export function parseSarif(output, relativize, { severity: forced = null } = {}) {
  const doc = JSON.parse(output);
  const findings = [];
  for (const run of doc.runs ?? []) {
    const rules = new Map();
    for (const rule of run.tool?.driver?.rules ?? []) rules.set(rule.id, rule);
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId) ?? run.tool?.driver?.rules?.[result.ruleIndex] ?? null;
      const loc = result.locations?.[0]?.physicalLocation;
      const file = relativize(loc?.artifactLocation?.uri);
      if (!file) continue;
      const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
      const message = String(result.message?.text ?? rule?.shortDescription?.text ?? result.ruleId ?? '').trim();
      findings.push({
        severity: forced ?? sarifSeverity(level, rule?.properties?.['security-severity']),
        file,
        line: loc?.region?.startLine ?? null,
        endLine: loc?.region?.endLine ?? null,
        title: message.split('\n')[0],
        issue: message,
        rule: result.ruleId ?? null,
      });
    }
  }
  return findings;
}

const TSC_PLAIN = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
const ANSI = /\u001b\[[0-9;]*m/g;

export function parseTsc(output, relativize) {
  const findings = [];
  for (const rawLine of String(output).split('\n')) {
    const line = rawLine.replace(ANSI, '').trimEnd();
    const m = line.match(TSC_PLAIN) ?? line.match(TSC_PRETTY);
    if (!m) continue;
    const file = relativize(m[1]);
    if (!file) continue;
    findings.push({
      severity: m[4] === 'error' ? 'high' : 'medium',
      file,
      line: Number(m[2]),
      title: `${m[5]}: ${m[6]}`,
      issue: `TypeScript ${m[4]} ${m[5]}: ${m[6]}`,
      rule: m[5],
    });
  }
  return findings;
}

export function parseEslintJson(output, relativize) {
  // ESLint may print warnings before the JSON document; parse from the first bracket.
  const start = String(output).indexOf('[');
  if (start === -1) throw new Error('no JSON array in ESLint output');
  const doc = JSON.parse(String(output).slice(start));
  const findings = [];
  for (const entry of doc) {
    const file = relativize(entry.filePath);
    if (!file) continue;
    for (const msg of entry.messages ?? []) {
      findings.push({
        severity: msg.fatal || msg.severity === 2 ? 'medium' : 'low',
        file,
        line: msg.line ?? null,
        endLine: msg.endLine ?? null,
        title: msg.message,
        issue: `${msg.message}${msg.ruleId ? ` (${msg.ruleId})` : ''}`,
        rule: msg.ruleId ?? null,
      });
    }
  }
  return findings;
}

const STYLISH_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?\s*$/;

export function parseEslintStylish(output, relativize) {
  const findings = [];
  let file = null;
  for (const rawLine of String(output).split('\n')) {
    const line = rawLine.replace(ANSI, '');
    const row = line.match(STYLISH_ROW);
    if (row && file) {
      findings.push({
        severity: row[3] === 'error' ? 'medium' : 'low',
        file,
        line: Number(row[1]),
        title: row[4].trim(),
        issue: `${row[4].trim()}${row[5] ? ` (${row[5]})` : ''}`,
        rule: row[5] ?? null,
      });
      continue;
    }
    // A file header is a non-indented line that is a path, not a summary ("✖ 3 problems").
    if (line.trim() !== '' && !/^\s/.test(line) && /[\\/.]/.test(line) && !/^[✖✔]/u.test(line.trim())) {
      file = relativize(line.trim());
    } else if (line.trim() === '') {
      file = null;
    }
  }
  return findings;
}

const GNU = /^(.+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|note|info)[:\s]\s*)?(.+)$/i;

export function parseGnu(output, relativize) {
  const findings = [];
  for (const rawLine of String(output).split('\n')) {
    const line = rawLine.replace(ANSI, '').trimEnd();
    const m = line.match(GNU);
    if (!m) continue;
    // Reject matches where the "path" is clearly prose or a URL.
    if (/\s/.test(m[1]) || /^[a-z]+:\/\//i.test(line)) continue;
    const file = relativize(m[1]);
    if (!file) continue;
    const level = (m[4] ?? 'warning').toLowerCase();
    findings.push({
      severity: level === 'error' ? 'high' : level === 'warning' ? 'medium' : 'low',
      file,
      line: Number(m[2]),
      title: m[5].trim(),
      issue: m[5].trim(),
      rule: null,
    });
  }
  return findings;
}

export const PARSER_FNS = Object.freeze({
  sarif: parseSarif,
  tsc: parseTsc,
  'eslint-json': parseEslintJson,
  'eslint-stylish': parseEslintStylish,
  gnu: parseGnu,
  'exit-code': () => [],
});
