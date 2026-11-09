// Kernel memory-pressure readings (spec: docs/specs/gate-process-tree/contract.md, PT-C8..C9).
// A reading that cannot be taken is null (unreadable), never a guess.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sysctlInt = (name) => {
  const r = spawnSync('sysctl', ['-n', name], { encoding: 'utf8' });
  const v = r.status === 0 ? Number((r.stdout || '').trim()) : NaN;
  return Number.isFinite(v) ? v : null;
};
const readUtf8 = (path) => readFileSync(path, 'utf8');
const tryParse = (readText, path, parse) => { try { return parse(readText(path)); } catch { return null; } }; // absent in some containers
const parsePsiAvg10 = (text) => { const m = text.match(/^some .*?avg10=([\d.]+)/m); return m ? Number(m[1]) : null; };
function parseAvailPct(text) {
  const total = Number(text.match(/^MemTotal:\s+(\d+)/m)?.[1]), avail = Number(text.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  return total > 0 && Number.isFinite(avail) ? (avail / total) * 100 : null;
}
export const readLinuxSample = (readText = readUtf8) => ({
  psiAvg10: tryParse(readText, '/proc/pressure/memory', parsePsiAvg10),
  availPct: tryParse(readText, '/proc/meminfo', parseAvailPct),
});
// `readText` is the Linux /proc reader (injectable, as in readLinuxSample).
export function readSample(platform, readText = readUtf8) {
  const none = { pressureLevel: null, levelPct: null, psiAvg10: null, availPct: null };
  if (platform === 'darwin') return { ...none, pressureLevel: sysctlInt('kern.memorystatus_vm_pressure_level'), levelPct: sysctlInt('kern.memorystatus_level') };
  if (platform === 'linux') return { ...none, ...readLinuxSample(readText) };
  return none;
}
