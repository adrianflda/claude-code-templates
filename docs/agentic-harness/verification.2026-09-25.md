# Verification record — 2026-09-25

An independent check of what is actually built versus what the documentation
claimed. Everything below was verified **by execution or by file inspection**,
not by reading prose. Method: run it, then read the result.

## Trigger

The plugin README stated *"The live breaker (M2) is the next milestone"*, while
commit `926cc4ad` in the same repository was titled
*"F1 — live UI oracle for the blind breaker"*. One of the two had to be wrong.

## What was found

**M2 is built.** It was not the next milestone.

| Artifact | Evidence |
| --- | --- |
| `scripts/breaker-gate.mjs` | Exists. Header: *"Composed gate WITH the enforced blind breaker — M2"* |
| `scripts/breaker-gate.test.mjs` | Exists, passes |
| M2 design chain | Complete: `spec-m2-plan-qa.v1.md`, `plan-m2-plan-qa.v1.md`, `tasks-m2-plan-qa.v1.md` |

**F1 is not M2.** They are distinct, and both exist:

- **M2** — the gate wiring (`breaker-gate.mjs`, 11 Sep)
- **F1** — the instrument, a live browser oracle (`gstack-breaker.mjs`,
  `gstack-probe.mjs`, `resolvers/gstack-browse.mjs`, 16-17 Sep)

## Test suite, executed

```
node --test "scripts/*.test.mjs"
tests 151 · pass 149 · fail 0 · skipped 2
```

The 2 skips require the `$B` browser binary and are expected without it.
Re-run after the documentation fixes below: identical result, no regression.

## The finding that matters more than the doc drift

**The breaker is built and does not run.**

`hooks/pre-push.sample` defaults to the gate *without* breaker enforcement:

```sh
GATE="${QK_GATE:-$ROOT/plugins/quality-kernel/scripts/qk-gate.mjs}"
```

And `breaker-gate.mjs`, even when invoked directly, returns exit 3 unless the
caller supplies `--breaker` — *"still unenforced; caller must supply --breaker
for a real critical merge"*.

So the honest state is neither "M2 pending" nor "M2 done". It is a third state:
**built, tested, and off by default.**

## Documentation defects corrected in this commit

1. **Plugin README** claimed M2 was the next milestone and never mentioned F1.
2. **`qk-gate.mjs` emitted a stale claim at runtime** — the note
   *"...is NOT yet enforced. Exit 3 = do-not-merge until M2 lands"* shipped to
   users and asserted that M2 had not landed. Also present in the file header
   and in the exit-code comment.
3. **Two broken relative citations.** The README cites
   `docs/agentic-harness/validation-panel.*`, but from inside the plugin that
   path resolves to a directory holding a single file. Verified:

   | Path | Files |
   | --- | --- |
   | `<repo>/docs/agentic-harness/` | 24 — the full design chain, including `validation-panel.v1.md` and `v2.md` |
   | `<repo>/plugins/quality-kernel/docs/agentic-harness/` | 1 — `f1-breaker-browser-bridge.md` |

   Anyone installing the plugin from the marketplace gets the broken citation
   and does not receive the red-team validation panel. Citations now use
   absolute source-repository URLs and say the chain is not bundled.

No test asserted on any of the changed strings; this was checked before editing.

## Open decision, deliberately not taken here

Whether `hooks/pre-push.sample` should default to `breaker-gate.mjs` instead of
`qk-gate.mjs` is a **product decision**, not a documentation fix. It changes
behaviour for every installed user. Left to the maintainer.
