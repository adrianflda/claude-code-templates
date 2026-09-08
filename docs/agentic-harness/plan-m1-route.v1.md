# Plan — M1: Deterministic Risk/Tier Router (`route.mjs`) — v1 (FROZEN)

> **Status:** FROZEN technical plan (SDD). Implements `spec-m1-route.v1.md` under
> `constitution.v1.md`. **Versioning:** never overwrite → `plan-m1-route.v2.md`.
> **Altitude:** design decisions + components + how each invariant is proven. Code is next (tasks).

## 1. Key design decisions
- **D1 — Standalone CLI, pure** (mirrors the referee): `route.mjs --repo <dir> --base <ref>
  [--changed a,b,c] [--proposed trivial|standard|critical]`. Exit `0` on a successful
  classification (including `critical`); exit `2` only on operational error (can't run git).
  The classification lives in the emitted JSON, never in the exit code (avoids clashing with the
  referee's `0/1/2` pass semantics).
- **D2 — Minimal built-in glob matcher, no dependencies.** A ~15-line glob→RegExp converter
  supporting `**` (any path incl. `/`), `*` (any run except `/`), `?` (one non-`/`), with regex
  specials escaped and full-path anchoring. *Why:* no picomatch/minimatch dep; the tool stays
  self-contained (like `crap.mjs`).
- **D3 — Tier order:** `trivial(0) < standard(1) < critical(2)`; `tier = max(floor, proposed)`.
- **D4 — Fail-safe classification (Constitution P5):** config absent/unreadable → any change is
  `critical` (there are no `safeGlobs` to demote it). No config ≠ no rigor.
- **D5 — Config location:** read `.quality-kernel/critical-surface.json`; ship the updated
  `config/critical-surface.example.json` as the copy-me template.

## 2. Components
| Component | Location | Role |
|---|---|---|
| `route.mjs` | `plugins/quality-kernel/scripts/` | resolve change → match globs → tierFloor/tier/requiresBreaker → verdict |
| `route.test.mjs` | `plugins/quality-kernel/scripts/` | INV-R1…R5 incl. the real-bug replay (`node --test`) |
| glob matcher | inside `route.mjs` (exported for its own tests) | `**`,`*`,`?` → RegExp |
| `fixtures/route/` | `plugins/quality-kernel/scripts/fixtures/route/` | changesets + a hand-authored `critical-surface.json` |
| template | `config/critical-surface.example.json` | the per-repo config to copy |

## 3. Flow of `route.mjs`
1. Resolve changed files: `--changed` list, else `git -C <repo> diff --name-only <base>...HEAD`
   (git error → exit 2).
2. Load `.quality-kernel/critical-surface.json` → `{criticalGlobs[], safeGlobs[]}` (absent → fail-safe).
3. Per changed path: `hitsCritical = any criticalGlob matches`; `isSafe = any safeGlob matches`.
4. `tierFloor` = `critical` if any hitsCritical (or fail-safe) · else `trivial` if all isSafe · else `standard`.
5. `tier = max(tierFloor, proposed)`; `requiresBreaker = tier==='critical'`.
6. Emit `{ tierFloor, tier, requiresBreaker, criticalFiles, reason }`; exit 0.

## 4. How each invariant is proven (spec §4 → tests)
| Invariant | Fixture / input | Assertion |
|---|---|---|
| INV-R1 | changed = a path under a criticalGlob | tierFloor `critical`, requiresBreaker true |
| INV-R2 | changed = only safeGlob paths | tierFloor `trivial` |
| INV-R3 | changed set, **no** critical-surface.json | tierFloor `critical` |
| INV-R4 | critical change `--proposed trivial`; trivial change `--proposed critical` | stays/`raised` to critical |
| INV-R5 | `--changed` = REAL PHI/IDOR files + REAL inhaler #560 files, vs the authored config | **both → `critical`** |

## 5. The real-bug replay (INV-R5) — inputs
- **PHI/IDOR** changed files (known): `app/controllers/copdMonitoringWebsocket.controller.ts`,
  `app/services/copdMonitoringSession.ts`.
- **Inhaler #560** changed files: resolved at build time via `git show --stat` on the #560 fix
  commit in `phoenixcare-call-websocket` (task T6).
- A hand-authored `fixtures/route/critical-surface.json` whose `criticalGlobs` must catch both
  (e.g. `**/*[Mm]onitoring*`, `**/controllers/**`, `**/*[Ss]ession*`, `realtime/**`, `**/*inhaler*`).

## 6. Definition of done
`route.mjs` + `route.test.mjs` + fixtures exist; `node --test` green on INV-R1…R5, above all the
INV-R5 replay forcing `critical` on both real bugs. = the M1 spec's DoD.
