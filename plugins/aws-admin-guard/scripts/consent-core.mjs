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
// Doubt is not consent: "no se si usar admin", "tal vez", "not sure", "maybe".
const DOUBT = /\b(no se|no estoy segur\w*|tal vez|quizas?|a lo mejor|not sure|maybe|perhaps|might)\b/;
// First person only: "autorizo", not "autorizar" / "autorizado" / "authorized" / "authorizing".
const AUTHORIZE = /\b(autorizo|autoriso|authorize|apruebo|approve)\b/;
// A question is not consent: "debo autorizar admin?".
const QUESTION = /[?\u00bf]/;
const AFFIRM_START = /^\W*(si|yes|ok|dale|adelante)\b/;
const CONFIRM = /\b(confirmo|reconfirmo|confirm|confirmed)\b/;
const REVOKE = /\b(revoco|revocar|revoca|revoke|revoked|retiro)\b/;
// A negation up to 3 tokens before "confirm" ("no confirmo", "I don't confirm") means the
// prompt does NOT confirm — unlike NEGATION above (which needs the admin verb nearby and
// revokes), this only cancels the confirmation; it does not revoke an existing grant.
const NEGATED_CONFIRM = /\b(no|nunca|jamas|never|dont|don't|do not|not)\b(?:\s+\S+){0,3}\s+\b(confirmo|reconfirmo|confirm|confirmed)\b/;

/** The verb and the profile name must be close: "autorizo usar admin", "usa admin", "use the admin profile". */
const nearProfile = (t, profiles) => profiles.some((p) =>
  new RegExp(`\\b(autoriz\\w*|authoriz\\w*|apruebo|approve\\w*|usa|usar|uses?|using)\\b\\W+(\\S+\\W+){0,3}?${esc(fold(p))}\\b(?!-)`).test(t));

/** What one human prompt means for the grant. */
export function classify(text, profiles) {
  const t = fold(text);
  const admin = mentions(t, profiles);
  if (REVOKE.test(t)) return 'revoke';
  if (admin && NEGATION.test(t)) return 'revoke';
  if (DOUBT.test(t) || QUESTION.test(t)) return 'none';
  if (nearProfile(t, profiles) && (AUTHORIZE.test(t) || AFFIRM_START.test(t))) return 'authorize';
  if (CONFIRM.test(t) && !NEGATION.test(t) && !NEGATED_CONFIRM.test(t)) return 'confirm';
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
    // A compaction summary is model-written, not typed by the human; entries carrying tool
    // metadata are tool output/ids, not a typed prompt either.
    if (e.isCompactSummary === true) continue;
    if (e.toolUseResult !== undefined || e.sourceToolUseID !== undefined || e.toolUseID !== undefined) continue;
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
