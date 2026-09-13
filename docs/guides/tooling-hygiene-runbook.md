# Runbook: Claude Code Tooling Hygiene + mattpocock/skills Adoption

A step-by-step guide for an AI agent to (1) adopt the `mattpocock/skills` engineering
skills and (2) declutter an overgrown global `~/.claude` config (skills, agents, commands),
WITHOUT losing any capability. Written to be run on a machine that is SIMILAR but NOT
identical to the reference machine, so it teaches a method and a decision rule, not a blind
list of deletions.

**Audience**: an agent (Claude Code CLI) with filesystem + Bash access on the target laptop.
**Golden rule**: never delete anything whose capability is not proven to survive elsewhere.
Move to a trash folder, never hard-delete. Verify against a backup, never against your own
self-report.

---

## Why this exists (the philosophy, from mattpocock/skills)

Two invisible costs justify every step below:

- **Context load**: every skill/agent `description` sits in the router's context on EVERY
  turn, spending tokens and attention whether or not it fires. Fewer, tighter descriptions
  = cheaper, sharper routing.
- **Cognitive load**: when several tools do the same job, neither the human nor the model's
  router can pick. Overlap is worse than absence: the router may choose a redundant, broken,
  or wrong tool. One job, one tool.

Removal targets are only: (a) BROKEN (cannot run), (b) an exact DUPLICATE of a tool still
present, (c) a strict SUBSET of a tool still present, or (d) a NO-OP (prescribes what the
model already does by default). Anything that is a distinct capability STAYS.

---

## Phase 0 — Prerequisites and environment scan

1. Confirm you are on the target machine and have Bash + file tools.
2. Scan the current setup. Do NOT assume it matches the reference machine:
   ```bash
   ls ~/.claude/agents | wc -l
   ls -d ~/.claude/skills/*/ | wc -l
   ls ~/.claude/commands | wc -l
   python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));print('plugins:',list(d.get('enabledPlugins',{}).keys()))"
   ```
3. Note which plugins are enabled. Capabilities provided by a plugin (e.g. `quality-kernel`,
   `pre-push-review`, `claude-mem`, `cc-safety-net`) are the LIVE REPLACEMENTS that make it
   safe to remove local duplicates. If a plugin is missing here that was present on the
   reference machine, its local duplicates are NOT safe to remove: keep them, or install the
   plugin first.

---

## Phase 1 — Recommend and install mattpocock/skills

`mattpocock/skills` is a set of small, composable, model-agnostic engineering skills
(https://github.com/mattpocock/skills). Prefer it over heavy process-owning frameworks.

**Recommended install route: skills.sh (editable copies you own), NOT the read-only plugin**,
so you can adapt each skill to this project's vocabulary:

```bash
npx skills@latest add mattpocock/skills
```

- When prompted, select the skills you want. ALWAYS include `setup-matt-pocock-skills`.
- Then run `/setup-matt-pocock-skills` ONCE per repo. It asks: issue tracker (GitHub/Linear/
  local files), triage labels, and where to save docs.

Highest-value skills to adopt first:
- `domain-modeling` / `grill-with-docs`: build a `CONTEXT.md` (ubiquitous language). Biggest
  win for any codebase with heavy in-house jargon.
- `writing-for-agents`: the reference for writing tight skill/agent descriptions (used in
  Phase 5).
- `tdd`, `diagnosing-bugs`: disciplined red-green and debugging loops.
- `codebase-design` + `improve-codebase-architecture`: deep-module design and periodic
  architecture surveys.

Do NOT install both the plugin and the skills.sh copies: that leaves every skill twice
(exactly the duplication this runbook removes).

---

## Phase 2 — Backup FIRST (non-negotiable)

Never edit `~/.claude` without a timestamped backup and a trash folder.

```bash
TS=$(date +%Y%m%d-%H%M%S)
BK="$HOME/.claude/backups/tooling-cleanup-$TS"
mkdir -p "$BK/removed/agents" "$BK/removed/skills" "$BK/removed/commands"
cp -R "$HOME/.claude/agents"   "$BK/agents"
cp -R "$HOME/.claude/skills"   "$BK/skills"
cp -R "$HOME/.claude/commands" "$BK/commands"
echo "$BK" > /tmp/claude-cleanup-backup-path.txt
echo "Backup at: $BK"
```

`$BK/removed/` is your trash. You MOVE deletions there; you never `rm` them. This also
sidesteps `cc-safety-net`, which blocks `rm -rf` outside the current working directory.

---

## Phase 3 — Audit: find the targets

Produce a findings list. Look for each category; record file paths, do not act yet.

1. **Broken agents** (imported from other tools). Their `tools:` reference tools that do not
   exist in Claude Code (e.g. `vscode/vscodeAPI`, `edit/editFiles`, `azure-mcp/search`,
   `codebase`). They cannot run.
   ```bash
   grep -lE "vscode/|edit/editFiles|azure-mcp|search/codebase|execute/runInTerminal" ~/.claude/agents/*.md
   ```
2. **Overlap clusters** (several tools, one job). Common clusters:
   - Multi-agent orchestration frameworks (e.g. `orchestrating-swarms`,
     `hierarchical-orchestration`, `project-orchestrator`/`subproject-pm`/`swarm-worker`,
     plus a plugin like `quality-kernel`). KEEP ONE.
   - Requirements coverage (a local skill + command + the plugin's versions). KEEP ONE.
   - SDD (a `sdd` skill + `sdd-*` commands + an `sdd-orchestrator` agent). Keep the command
     chain; drop the narrating skill/agent.
   - Test generation (`generate-tests` vs `write-tests`). MERGE.
   - DevOps (`deployment-engineer` vs `devops-engineer`). MERGE.
   - Voice (`voice-agents` vs `voice-ai-development`). MERGE (keep the superset).
   - "senior-*" mega-skills vs specialist agents + best-practice skills. Drop the mega-skills.
   - Refactor/simplify (`code-simplifier` vs built-in `simplify` + `refactoring-specialist`).
   - Security (`api-security-audit` is a subset of `security-auditor`; but `security-engineer`
     BUILDS controls and is DISTINCT from auditor=review and pentester=exploit: KEEP it).
3. **No-ops**: skills that prescribe default behavior (e.g. "offer at least 3 alternatives",
   hardcoded output templates).
4. **Verbose descriptions**: agents whose `description` embeds full `<example>` blocks.
   ```bash
   grep -l "<example>" ~/.claude/agents/*.md | wc -l
   ```

---

## Phase 4 — The decision rule (apply per candidate)

For EACH removal candidate, before touching it, answer: **what is the live replacement?**
Write it down as a mapping. A candidate may be removed ONLY if one holds:

- BROKEN: it references non-existent tools -> cannot run -> safe.
- DUPLICATE: byte-identical (or identical minus a hardcoded path) to a tool still present
  (often the plugin version using `${CLAUDE_PLUGIN_ROOT}`). Confirm with `diff`.
- SUBSET: its scope is fully contained in a tool still present.
- NO-OP: prescribes default behavior only.

If none holds, it is a DISTINCT capability: KEEP it, even if a generic audit suggested
removing it. (Example from the reference run: `security-engineer` was kept because build !=
review != exploit; `technical-debt-manager` was kept because analyze/prioritize != execute.)

Verify the replacement actually EXISTS before removing the candidate:
```bash
# example: confirm the plugin ships the surviving version + its scripts
ls ~/.claude/plugins/**/quality-kernel*/commands/develop.md 2>/dev/null
```

---

## Phase 5 — Execute (adapt to THIS machine's findings)

Move candidates to trash (never `rm`). Check references first so you do not orphan a caller.

```bash
BK=$(cat /tmp/claude-cleanup-backup-path.txt)

# 5a. Check nothing still references a candidate (edit the regex to your candidates):
grep -rlE "code-simplifier|api-security-audit|orchestrating-swarms" \
  ~/.claude/agents ~/.claude/skills ~/.claude/commands 2>/dev/null | grep -v "/backups/"

# 5b. Move an agent / a skill dir / a command to trash:
mv ~/.claude/agents/<name>.md   "$BK/removed/agents/"
mv ~/.claude/skills/<name>      "$BK/removed/skills/"
mv ~/.claude/commands/<name>.md "$BK/removed/commands/"
```

For MERGES (e.g. `write-tests` into `generate-tests`): first fold any unique triggers from
the loser's description into the keeper's `description`, then move the loser to trash.

For a local tool that duplicates a plugin tool EXCEPT a hardcoded path: prefer the plugin
version (it uses `${CLAUDE_PLUGIN_ROOT}` and cannot go stale). Confirm the plugin ships the
backing scripts, then move the local one to trash.

### Phase 5.1 — Trim verbose agent descriptions (biggest context-load win)

For each agent whose `description` contains `<example>` blocks, replace ONLY the `description`
frontmatter value with ONE tight, single-line, double-quoted YAML string. Rules (from
`writing-for-agents`):
- Front-load the trigger; state the capability; distill the example triggers into
  comma-separated keywords so routing is preserved.
- Cut "Use this agent when...", cut the worked `<example>`/`<commentary>` blocks entirely.
- Preserve sibling disambiguation (e.g. auditor=review vs engineer=build vs pentester=exploit;
  architect=design vs developer=implement).
- No em-dashes. No inner double quotes (rephrase to avoid them). No newlines.
- NEVER touch the body (after the closing `---`) or other frontmatter keys (name, tools,
  model, color).
- Target ~200-400 chars. This is bulk careful work: a subagent can do all of them in
  parallel, but the parent MUST verify (Phase 6), not trust the subagent's self-report.

---

## Phase 6 — Verify (the part that catches mistakes)

Run ALL of these. Note the gotchas: they bit the reference run.

> GOTCHA 1 (zsh): unquoted `$VAR` does NOT word-split in zsh. Use `${=FILES}` in a `for`
> loop, or the checks silently run once on the whole string and print FALSE passes.
> GOTCHA 2: verify against the BACKUP with `diff`/`md5`, never against a subagent's summary.

```bash
BK=$(cat /tmp/claude-cleanup-backup-path.txt)

# 6a. Every remaining agent's frontmatter parses with name + description:
for f in ~/.claude/agents/*.md; do
  python3 -c "import yaml;d=yaml.safe_load(open('$f').read().split('---',2)[1]);assert 'name' in d and 'description' in d" \
    2>/dev/null || echo "BAD FRONTMATTER: $f"
done
# (A file with NO frontmatter, e.g. one that starts with '# Title', will flag here. If it is
#  identical to the backup, it is PRE-EXISTING, not caused by this cleanup. Confirm with diff.)

# 6b. For any agent you edited, the BODY must be byte-identical to the backup:
for f in <edited-agent-basenames>; do
  n=$(awk 'c==2{print} /^---$/{c++}' ~/.claude/agents/$f.md | md5)
  o=$(awk 'c==2{print} /^---$/{c++}' "$BK/agents/$f.md" | md5)
  [ "$n" = "$o" ] || echo "BODY CHANGED: $f"
done

# 6c. Zero dangling references to anything you removed (edit the regex):
grep -rlE "<removed1>|<removed2>" ~/.claude/agents ~/.claude/skills ~/.claude/commands \
  ~/.claude/CLAUDE.md 2>/dev/null | grep -vE "/backups/|\.bak-" || echo "OK: no dangling refs"

# 6d. Capability integrity: for each removed item, print its live replacement and confirm it exists.
#     Build this table explicitly; an empty replacement column means STOP and restore that item.
```

Fix any dangling reference by re-pointing it to the surviving tool (do not leave a pointer to
a deleted target). Then re-run 6c until clean.

---

## Phase 7 — Per-repo domain model (the highest-leverage skill)

In each active repo, run `domain-modeling` (or `/grill-with-docs`) to produce a `CONTEXT.md`:
the 8-15 highest-weight domain terms, each grounded in `file:symbol`, with an `_Avoid_` line
listing the inconsistent synonyms currently used for that same concept, plus `Relationships`
and `Flagged ambiguities` sections. Write it in the repo's required language (English unless
the repo targets a non-English audience). This is what reduces the agent's verbosity and
token spend session after session.

Guard against jargon bleed: a term that appears in NO file (`grep` returns nothing) is likely
imported from an example/doc you were reading, not a real project term. Do not invent a
definition for it; flag it and confirm with the human.

---

## Phase 8 — Record and roll back

- Record what changed and why (which items removed, and each one's live replacement) in a note
  or in your memory system, so the decision is auditable later.
- ROLLBACK: everything removed is in `$BK/removed/`. To restore one item:
  ```bash
  mv "$BK/removed/agents/<name>.md" ~/.claude/agents/
  ```
  The full pre-change copies are in `$BK/agents`, `$BK/skills`, `$BK/commands`.

---

## Done criteria

- mattpocock/skills installed (editable) and `/setup-matt-pocock-skills` run per repo.
- Every removed tool maps to a named, verified live replacement (or was broken/no-op).
- All remaining agents parse; edited agents' bodies unchanged vs backup.
- Zero dangling references.
- Verbose agent descriptions trimmed to one line each.
- A `CONTEXT.md` exists for each active repo.
- A timestamped backup + trash folder exists for rollback.
