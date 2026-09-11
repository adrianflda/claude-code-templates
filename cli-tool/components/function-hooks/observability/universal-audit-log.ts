/**
 * universal-audit-log — Function Hook (EXPERIMENTAL)
 *
 * One hook on "*" sees every event on $, including every other plugin's own
 * calls, and appends a JSON line per dispatch: who raised it, what it was,
 * how long it took and whether something below denied it.
 * Placement: "after" (wraps next so the outcome is recorded too).
 *
 * Register this plugin FIRST (prepend it in managed settings) so nothing
 * beneath it can bypass the log — design doc §5.
 *
 * Function hooks are an Anthropic proposal under community review:
 * https://github.com/anthropics/claude-code/issues/91870
 * Every API name below is provisional. $.fs.append is the assumed shape of
 * the "files" primitive.
 */

type Engine = any;
type Next = ((e: any) => Promise<any>) & { event: string; origin: string; signal: AbortSignal; is: (type: string, e: any) => boolean };

const MAX_FIELD = 200;

// Field names whose value is almost always a credential or personal datum.
const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|auth(orization)?|credential|cookie|session|bearer|private[_-]?key)/i;
// Secret-shaped values. Kept in lockstep with the security/secret-redactor
// hook's PATTERNS so both recognise the same credential shapes (notably the
// hyphenated sk-ant-api…/sk-proj… keys a naive [A-Za-z0-9]+ run misses).
const SENSITIVE_VALUE = new RegExp(
  [
    /bearer\s+\S+/.source,
    /\bAKIA[0-9A-Z]{16}\b/.source,
    /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/.source,
    /\bsk-[A-Za-z0-9-]{20,}\b/.source,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.source,
    /\bAIza[0-9A-Za-z_-]{35}\b/.source,
    /\b[sr]k_(live|test)_[0-9A-Za-z]{24,}\b/.source,
    /\bxox[abpr]-[0-9A-Za-z-]{10,}\b/.source,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.source,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.source,
    /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^:\s]+:[^@\s]+@/.source,
  ].join("|"),
  "i",
);
const REDACTED = "[redacted]";

function redactString(v: string): string {
  if (SENSITIVE_VALUE.test(v)) return REDACTED;
  return v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + "…" : v;
}

// Summarize an event for the log. Sensitive fields are redacted, not truncated —
// truncation is not redaction. Set options.captureInput = false to omit input
// fields entirely.
function summarize(e: any): Record<string, unknown> {
  if (!e || typeof e !== "object") return { value: redactString(String(e)) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = REDACTED; continue; }
    if (typeof v === "string") out[k] = redactString(v);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = `[array:${v.length}]`;
    else if (v && typeof v === "object") out[k] = `[object]`;
  }
  return out;
}

export function register(on: any, options: Record<string, any> = {}) {
  const logPath: string = options.path ?? ".claude/logs/function-hooks-audit.jsonl";
  const skip = new Set<string>(options.skipEvents ?? ["ui.log", "ui.render", "ui.resolve"]);
  // Input fields are captured (redacted) by default; set false to omit them.
  const captureInput: boolean = options.captureInput ?? true;

  on("*", async ($: Engine, e: any, next: Next) => {
    if (skip.has(next.event)) return next(e);

    const startedAt = Date.now();
    let outcome = "ok";
    let result: any;
    try {
      result = await next(e);
      if (result && typeof result === "object" && "deny" in result) outcome = `denied: ${result.deny}`;
    } catch (err: any) {
      outcome = `threw: ${err?.message ?? String(err)}`;
      throw err;
    } finally {
      const line = JSON.stringify({
        ts: new Date(startedAt).toISOString(),
        event: next.event,
        origin: next.origin,
        durationMs: Date.now() - startedAt,
        outcome,
        ...(captureInput ? { input: summarize(e) } : {}),
      });
      // The hook is not re-entered for its own $.fs call (design doc §6.4),
      // so appending from inside a "*" hook does not recurse.
      // Logging is best-effort: an unwritable log dir or full disk must never
      // fail the wrapped event (this is a catch-all "*" hook), nor mask an
      // error already thrown by next().
      try {
        await $.fs.append({ path: logPath, data: line + "\n" });
      } catch (logErr: any) {
        try { $.log?.warn?.(`universal-audit-log: could not write ${logPath}: ${logErr?.message ?? logErr}`); } catch {}
      }
    }
    return result;
  });
}
