// Test support (not a test): the org gate config the run-journal suites need so that `resume` can
// re-run the real qk-gate (spec §5.3) on their fixture repos. Each fixture repo commits CHECK at its
// base; the gate's verify runs it on the materialised tree, and a `*.txt` file containing the word
// BROKEN makes it fail — the way a test breaks at a green SHA (INV-4).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CHECK_FILE = 'check.mjs';
export const CHECK = `import { readdirSync, readFileSync } from 'node:fs';
for (const f of readdirSync('.')) if (f.endsWith('.txt') && readFileSync(f, 'utf8').includes('BROKEN')) { console.error('broken: ' + f); process.exit(1); }
`;
const put = (root, p, c) => { const d = join(root, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };

// Org guide (.claude/org-workspace/guide.json) listing `names` as apps, plus tools.json and
// critical-surface.json for each under .quality-kernel/repos/<name>/ (nothing critical: exit 0 when green).
export function writeGateConfig(org, names) {
  put(org, '.claude/org-workspace/guide.json', JSON.stringify({ version: 1, org: 'Org', repos: names.map((name) => ({ name, role: 'app', base: 'main' })), forbidden: [] }));
  for (const name of names) {
    writeRepoGateFile(org, name, 'tools.json', { verify: `node ${CHECK_FILE}`, productionGlobs: ['**/*.txt'] });
    writeRepoGateFile(org, name, 'critical-surface.json', { criticalGlobs: ['critical/**'], safeGlobs: [] });
  }
}
// One gate config file of repo `name` (tools.json or critical-surface.json), replaced.
export const writeRepoGateFile = (org, name, file, obj) => put(org, `.quality-kernel/repos/${name}/${file}`, JSON.stringify(obj));
