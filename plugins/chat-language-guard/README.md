# chat-language-guard

A rule and the hooks that enforce it: **Claude talks to the user in Spanish. Only what leaves the
chat (code, commits, PRs, issues, files, artifacts) is English.**

## How it works

- `SessionStart`: adds [`RULE.md`](RULE.md) to the session context.
- `UserPromptSubmit`: a one-line reminder on every prompt, so the rule is fresh exactly when Claude
  starts writing.
- `Stop`: when Claude is about to end its turn, the hook reads everything it told the user in the
  turn (interim notes between tool calls included; subagents and API error notices excluded). If
  any of it is English prose, it blocks the stop once and asks for a short Spanish rewrite.

The detector ignores English that belongs in a Spanish message: fenced code, inline code, URLs,
paths and file names, and blockquotes (`> ...`, for quoting a title or an error). It then counts
English and Spanish function words per line. Tested against a real 1064-message session: it
flagged the 92 English messages and no Spanish one.

## Limits

- The user has already seen the English text when the hook fires: it guarantees a correction in
  the same turn, not that English never appears.
- It blocks at most once per turn, so a false positive costs one extra message and never a loop.
- Only Spanish (target) vs English (mistake) is supported.
- Off switch: `CHAT_LANGUAGE_GUARD_DISABLE=1`.

## Tests

```bash
npm test   # node --test, no dependencies
```
