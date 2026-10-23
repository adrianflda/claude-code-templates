// Memory-pressure guard (spec: docs/specs/gate-process-tree/contract.md, PT-C8..C11, Decisions 16-17).
// Refuses a run BEFORE it creates any temp tree or lock. Signals are the kernel's own pressure state;
// os.freemem(), process.availableMemory() and vm.swapusage are NOT signals (freemem reported 0.21 GB
// on a machine 89 percent free). Thresholds are judgment values from the design, not measurements.
import { resolveGuardConfig } from './mem-config.mjs';
import { readSample, readLinuxSample } from './mem-signals.mjs';

export { resolveGuardConfig, readSample, readLinuxSample };

const PSI_MAX = 25; // Linux `some avg10`, fixed

// Refusal is strict: level >= max, pct < min, PSI > 25. A null reading is an unreadable signal.
// Each probe: [sample key, reported signal name, threshold, breached(value, threshold)].
const probes = ({ maxLevel, minPct }) => [
  ['pressureLevel', 'kern.memorystatus_vm_pressure_level', maxLevel, (v, t) => v >= t],
  ['levelPct', 'kern.memorystatus_level', minPct, (v, t) => v < t],
  ['psiAvg10', '/proc/pressure/memory some avg10', PSI_MAX, (v, t) => v > t],
  ['availPct', '/proc/meminfo MemAvailable/MemTotal percent', minPct, (v, t) => v < t],
];
export function evaluatePressure(sample, thresholds) {
  const read = probes(thresholds).filter(([key]) => sample[key] !== null);
  const breaches = read
    .filter(([key, , threshold, breached]) => breached(sample[key], threshold))
    .map(([key, signal, threshold]) => ({ signal, value: sample[key], threshold }));
  return { readable: read.length > 0, breaches };
}

const describeBreaches = (breaches) => breaches.map((b) => `${b.signal} = ${b.value} (threshold ${b.threshold})`).join('; ');
function checkPressure(env, platform, read, warn) {
  const cfg = resolveGuardConfig(env, platform);
  if (cfg.error) return { ok: false, reason: cfg.error };
  if (cfg.off) return { ok: true };
  const { readable, breaches } = evaluatePressure(read(platform), cfg);
  if (breaches.length) return { ok: false, reason: `memory pressure too high to start a gate run: ${describeBreaches(breaches)}` };
  if (!readable) warn('quality-kernel: no memory-pressure signal could be read; proceeding without the memory guard');
  return { ok: true };
}

// -> { ok: true } | { ok: false, reason }. PT-C9: an unreadable probe warns on stderr and passes.
export function runMemoryGuard({ env = process.env, platform = process.platform, read = readSample, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  return checkPressure(env, platform, read, warn);
}
