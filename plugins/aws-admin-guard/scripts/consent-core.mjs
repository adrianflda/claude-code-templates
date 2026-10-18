/**
 * The consent model of aws-admin-guard, shared by both hooks.
 *
 * The oracle is the session transcript that Claude Code writes: only prompts the human
 * typed count (type "user", plain text, not meta, not a sidechain, origin "human" when the
 * field exists). Claude cannot author those entries, so it cannot grant itself access.
 *
 * Two SEPARATE prompts are needed: one that authorizes the admin profile, then one that
 * confirms within WINDOW minutes. The grant lasts TTL minutes from the confirmation.
 * A later prompt that revokes or negates admin closes it.
 */
import { readFileSync } from 'node:fs';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const config = () => ({
  profiles: (process.env.AWS_ADMIN_GUARD_PROFILES || 'admin').split(',').map((s) => s.trim()).filter(Boolean),
  ttlMs: num(process.env.AWS_ADMIN_GUARD_TTL_MIN, 30) * 60_000,
  windowMs: num(process.env.AWS_ADMIN_GUARD_WINDOW_MIN, 15) * 60_000,
});

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mentions = (t, profiles) => profiles.some((p) => new RegExp(`\\b${esc(fold(p))}\\b(?!-)`).test(t));
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The negation must sit right before the verb ("no uses", "no lo uses", "don't use"), so a
// later, unrelated "no" in the same prompt does not read as a refusal.
const NEGATION = /\b(no|nunca|jamas|never|dont|don't|do not)\s+(\w+\s+)?(uses?|usar|usa|using|autoriz\w*|authoriz\w*|admin)\b/;
const AUTHORIZE = /\b(autorizo|autorizado|autorizada|authorize|authorized|apruebo|approve|approved)\b/;
const AFFIRM_USE = /\b(si|yes|ok|dale|adelante)\b\W+(\S+\W+){0,2}?(usa|usar|use|using)\b\W+(\S+\W+){0,3}?/;
const CONFIRM = /\b(confirmo|reconfirmo|confirm|confirmed)\b/;
const REVOKE = /\b(revoco|revocar|revoca|revoke|revoked|retiro)\b/;

/** What one human prompt means for the grant. */
export function classify(text, profiles) {
  const t = fold(text);
  const admin = mentions(t, profiles);
  if (REVOKE.test(t)) return 'revoke';
  if (admin && NEGATION.test(t)) return 'revoke';
  if (admin && (AUTHORIZE.test(t) || AFFIRM_USE.test(t))) return 'authorize';
  if (CONFIRM.test(t) && !NEGATION.test(t)) return 'confirm';
  return 'none';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return null;
  const parts = content.filter((b) => b?.type === 'text').map((b) => b.text);
  return parts.length ? parts.join('\n') : null;
}

/** Human-typed prompts from a transcript, oldest first: [{ text, ts }]. */
export function humanPrompts(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'user' || e.isMeta || e.isSidechain) continue;
    if (e.origin && e.origin.kind !== 'human') continue;
    const text = textOf(e.message?.content);
    if (!text || text.trimStart().startsWith('<')) continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isFinite(ts)) out.push({ text, ts });
  }
  return out;
}

/** Replay the prompts: { stage: 'none'|'pending'|'granted', since, expiresAt }. */
export function grantState(prompts, now, cfg = config()) {
  let s = { stage: 'none' };
  for (const { text, ts } of prompts) {
    const kind = classify(text, cfg.profiles);
    if (kind === 'revoke') s = { stage: 'none', revokedAt: ts };
    else if (kind === 'confirm' && s.stage === 'pending' && ts - s.since <= cfg.windowMs) {
      s = { stage: 'granted', since: ts, expiresAt: ts + cfg.ttlMs };
    } else if (kind === 'authorize') s = { stage: 'pending', since: ts };
  }
  if (s.stage === 'granted' && now > s.expiresAt) return { stage: 'none', expired: true };
  if (s.stage === 'pending' && now - s.since > cfg.windowMs) return { stage: 'none', expired: true };
  return s;
}
