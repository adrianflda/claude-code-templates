// Memory-guard configuration (spec: docs/specs/gate-process-tree/contract.md, PT-C10..C11, Decisions 16-17).
const DEFAULT_MAX_LEVEL = 2; // macOS: 2 = warn, 4 = critical
const DEFAULT_MIN_PCT = { darwin: 20, linux: 15 };

// Decision 17: invalid values fail closed naming the variable. Level: integer >= 1. Percent: number >= 0.
const invalid = (name, rule, value) => ({ error: `${name} must be ${rule} (got ${JSON.stringify(value)})` });
const GUARD_MODES = new Set(['on', 'off']);
const defaultMinPct = (platform) => DEFAULT_MIN_PCT[platform] ?? DEFAULT_MIN_PCT.darwin;
function numberOverride(env, name, rule, isValid, fallback) {
  const raw = env[name];
  if (raw === undefined) return { value: fallback };
  return isValid(raw) ? { value: Number(raw) } : invalid(name, rule, raw);
}
export function resolveGuardConfig(env, platform) {
  const g = env.QK_MEM_GUARD;
  if (g !== undefined && !GUARD_MODES.has(g)) return invalid('QK_MEM_GUARD', 'unset, "on" or "off"', g);
  if (g === 'off') return { off: true };
  const level = numberOverride(env, 'QK_MEM_MAX_PRESSURE_LEVEL', 'an integer >= 1', (v) => /^\d+$/.test(v) && Number(v) >= 1, DEFAULT_MAX_LEVEL);
  if (level.error) return level;
  const pct = numberOverride(env, 'QK_MEM_MIN_LEVEL_PCT', 'a number >= 0', (v) => /^\d+(\.\d+)?$/.test(v), defaultMinPct(platform));
  if (pct.error) return pct;
  return { off: false, maxLevel: level.value, minPct: pct.value };
}
