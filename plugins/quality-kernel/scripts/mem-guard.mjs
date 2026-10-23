// Memory-pressure guard (spec: docs/specs/gate-process-tree/contract.md, PT-C8..C11, Decisions 16-17).
// Refuses a run BEFORE it creates any temp tree or lock. Signals are the kernel's own pressure state;
// os.freemem(), process.availableMemory() and vm.swapusage are NOT signals (freemem reported 0.21 GB
// on a machine 89 percent free). Thresholds are judgment values from the design, not measurements.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PSI_MAX = 25; // Linux `some avg10`, fixed
const DEFAULT_MAX_LEVEL = 2; // macOS: 2 = warn, 4 = critical
const DEFAULT_MIN_PCT = { darwin: 20, linux: 15 };

// Refusal is strict: level >= max, pct < min, PSI > 25. A null reading is an unreadable signal.
export function evaluatePressure(sample, { maxLevel, minPct }) {
  const breaches = [];
  const { pressureLevel, levelPct, psiAvg10, availPct } = sample;
  if (pressureLevel !== null && pressureLevel >= maxLevel) breaches.push({ signal: 'kern.memorystatus_vm_pressure_level', value: pressureLevel, threshold: maxLevel });
  if (levelPct !== null && levelPct < minPct) breaches.push({ signal: 'kern.memorystatus_level', value: levelPct, threshold: minPct });
  if (psiAvg10 !== null && psiAvg10 > PSI_MAX) breaches.push({ signal: '/proc/pressure/memory some avg10', value: psiAvg10, threshold: PSI_MAX });
  if (availPct !== null && availPct < minPct) breaches.push({ signal: '/proc/meminfo MemAvailable/MemTotal percent', value: availPct, threshold: minPct });
  const readable = [pressureLevel, levelPct, psiAvg10, availPct].some((v) => v !== null);
  return { readable, breaches };
}

// Decision 17: invalid values fail closed naming the variable. Level: integer >= 1. Percent: number >= 0.
export function resolveGuardConfig(env, platform) {
  const g = env.QK_MEM_GUARD;
  if (g !== undefined && g !== 'on' && g !== 'off') return { error: `QK_MEM_GUARD must be unset, "on" or "off" (got ${JSON.stringify(g)})` };
  if (g === 'off') return { off: true };
  let maxLevel = DEFAULT_MAX_LEVEL, minPct = DEFAULT_MIN_PCT[platform] ?? DEFAULT_MIN_PCT.darwin;
  const lv = env.QK_MEM_MAX_PRESSURE_LEVEL, pc = env.QK_MEM_MIN_LEVEL_PCT;
  if (lv !== undefined) {
    if (!/^\d+$/.test(lv) || Number(lv) < 1) return { error: `QK_MEM_MAX_PRESSURE_LEVEL must be an integer >= 1 (got ${JSON.stringify(lv)})` };
    maxLevel = Number(lv);
  }
  if (pc !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(pc)) return { error: `QK_MEM_MIN_LEVEL_PCT must be a number >= 0 (got ${JSON.stringify(pc)})` };
    minPct = Number(pc);
  }
  return { off: false, maxLevel, minPct };
}

const sysctlInt = (name) => {
  const r = spawnSync('sysctl', ['-n', name], { encoding: 'utf8' });
  const v = r.status === 0 ? Number((r.stdout || '').trim()) : NaN;
  return Number.isFinite(v) ? v : null;
};
function readLinuxSample() {
  const s = { psiAvg10: null, availPct: null };
  try { const m = readFileSync('/proc/pressure/memory', 'utf8').match(/^some .*?avg10=([\d.]+)/m); if (m) s.psiAvg10 = Number(m[1]); } catch { /* absent in some containers */ }
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(mi.match(/^MemTotal:\s+(\d+)/m)?.[1]), avail = Number(mi.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    if (total > 0 && Number.isFinite(avail)) s.availPct = (avail / total) * 100;
  } catch { /* unreadable */ }
  return s;
}
export function readSample(platform) {
  const none = { pressureLevel: null, levelPct: null, psiAvg10: null, availPct: null };
  if (platform === 'darwin') return { ...none, pressureLevel: sysctlInt('kern.memorystatus_vm_pressure_level'), levelPct: sysctlInt('kern.memorystatus_level') };
  if (platform === 'linux') return { ...none, ...readLinuxSample() };
  return none;
}

// -> { ok: true } | { ok: false, reason }. PT-C9: an unreadable probe warns on stderr and passes.
export function runMemoryGuard({ env = process.env, platform = process.platform, read = readSample, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const cfg = resolveGuardConfig(env, platform);
  if (cfg.error) return { ok: false, reason: cfg.error };
  if (cfg.off) return { ok: true };
  const { readable, breaches } = evaluatePressure(read(platform), cfg);
  if (breaches.length) {
    return { ok: false, reason: `memory pressure too high to start a gate run: ${breaches.map((b) => `${b.signal} = ${b.value} (threshold ${b.threshold})`).join('; ')}` };
  }
  if (!readable) warn('quality-kernel: no memory-pressure signal could be read; proceeding without the memory guard');
  return { ok: true };
}
