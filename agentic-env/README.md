# agentic-env — install the agentic tooling on another machine

One command puts the same agentic tooling on a second Mac: the review panel, the quality-kernel,
usage-guard, the epistemic hooks, and the agents, skills and commands they rely on. It is **not**
a copy of `~/.claude`. Machine config, account names, account ids and secrets are not in here and
must never be added.

## Install

```bash
git clone https://github.com/adrianflda/claude-code-templates.git ~/Projects/personal/cct-main
cd ~/Projects/personal/cct-main
python3 -I agentic-env/install.py --check   # what is missing (changes nothing)
python3 -I agentic-env/install.py           # install / update (idempotent)
```

Then restart Claude Code. To update later, run `git pull` and then the installer again.

Requires `python3`, `node` (for the pre-push gate) and the `claude` CLI on `PATH`. The external
tools also need `uv` and Python 3.12 (`brew install uv python@3.12`): the system `python3` on macOS
is too old for them. Without those two the rest still installs and the tool is reported as drift.

## What it does

Everything comes from [`manifest.json`](manifest.json):

| Piece | Where it goes |
|---|---|
| agents `adversarial-critic`, `pipeline-breaker`, `qa-expert` (from `cli-tool/components`) and the eight in `agentic-env/agents/` (the catalog agents with their Opus/Sonnet pins and one-paragraph descriptions: every description is loaded into each session) | `~/.claude/agents/` |
| skills `epistemic-discipline`, `qa-paradigms`, `skill-audit-3r`, and the two in `agentic-env/skills/`: `library-docs` (current third-party docs from Context7) and `code-graph` (a local structural graph of a codebase) | `~/.claude/skills/<name>/` |
| commands `/diagnose`, `/quality-gate` | `~/.claude/commands/` |
| hooks in [`hooks/`](hooks) | `~/.claude/hooks/`; each one is wired into `~/.claude/settings.json` |
| plugins `quality-kernel`, `pre-push-review`, `usage-guard`, `pr-draft-guard`, `aws-admin-guard`, `agent-skills` | installed from this repo's marketplace (`adrianflda-claude-code-templates`) |
| external tools in the manifest's `tools` list (today `graphifyy`, which gives the `graphify` command) | `uv tool install`, at the exact version the manifest pins |
| pre-push review gate | global git config, via `plugins/pre-push-review/scripts/install-git-hook.mjs` |

Behaviour:

- **Additive only.** It overwrites a manifest file that differs from the repo copy and never
  deletes anything.
- **`settings.json` is merged, not replaced.** Only missing hook entries are added; your own hooks
  and settings stay as they are. Before any write it saves a backup, `settings.json.bak-<timestamp>`.
- **Exit codes:**
  - `--check` exits 0 when the machine is in sync and 1 on drift.
  - An install exits 0 when, after installing, the machine is in sync. It exits 2 when a step
    failed or drift remains.
- **Marketplace path mismatch.** The installer does not repair this case. If `--check` reports
  `market ... reads <path>, not this clone`, the marketplace was added from another folder.
  Remove it with `claude plugin marketplace remove adrianflda-claude-code-templates`, then run the
  installer again.
- **A second copy of a plugin.** A manifest plugin that is also enabled from another marketplace
  (an older local one, for example) runs its hooks twice, and the other copy is usually stale.
  `--check` reports it, and the installer warns about it, with the `claude plugin uninstall` command
  to run; neither removes it, since the installer never deletes anything.
- **Partial install.** `--no-plugins` skips the `claude plugin` and git steps. `--no-tools` skips
  the external tools. With both, it installs only the files and the hook wiring.
- **External tools are pinned.** A tool at another version than the manifest's is drift, and the
  installer replaces it with the pinned one. It never downloads a Python: when `uv` or the Python
  the tool needs is missing it prints `skip` with the `brew` command and exits 2. The pin is the
  package version; the tool's own dependencies are resolved by `uv` and are not hash-locked.

## Which tool for which job

The pieces are meant not to overlap. The same rule goes in the machine's `~/.claude/CLAUDE.md`
(the installer never edits that file):

```markdown
## Which tool for which job

- Building or fixing code: use the matching skill in the main session. Do not spawn an agent for it.
- Agents: only for an independent check of finished work (adversarial-critic, pipeline-breaker,
  an audit the user asked for) or for parallel work that would flood the main context.
- A whole feature from a description: quality-kernel (/forge, /develop). No other orchestrator.
- On push: pre-push-review runs by itself. Do not run a second review pass before it.
```

An agent whose description says "use proactively" for a task a skill already covers gets spawned
in place of the skill, at the cost of a whole separate context. `react-specialist` left the
manifest for that reason: sixty days of transcripts on the author's machine showed two uses.

## Third-party pieces and what they may send

Three pieces come from outside. Each is used in a narrower way than its own installer sets up.

| Piece | How it is used here | What leaves the machine |
|---|---|---|
| [Context7](https://github.com/upstash/context7) | `library-docs` calls its HTTPS API from one stdlib script. No account, no MCP server, no npm package. | The library name and the question, nothing else. The script refuses the obvious leaks (long or multi-line text, backticks, path-like tokens, more than a few digits); it cannot tell a private name from a public one. |
| [Graphify](https://github.com/Graphify-Labs/graphify) | `code-graph` runs `graphify update`, `explain`, `path`, `affected`: local parsing, no LLM. | Nothing with those commands. The skill forbids the ones that fetch, call an LLM, or edit `CLAUDE.md` (`graphify install` does). |
| [agent-skills](https://github.com/addyosmani/agent-skills) | Vendored in [`plugins/agent-skills`](../plugins/agent-skills) at a pinned commit, skills only, most of them user-invoked. | Nothing by itself: it is instructions. |

**No-egress folders.** On a machine that holds client code, list those folders in
`AGENTIC_ENV_NO_EGRESS_DIRS` (absolute paths separated by `:`) in the `env` block of
`~/.claude/settings.json`. `library-docs` then refuses to send anything while the working
directory is inside one; an entry that is not absolute makes it refuse everywhere, so a typo is
noticed. The value is machine-specific, so the installer does not set it. This guards one script,
not the machine: it does not stop other tools from reaching the network.

## Opt-in, not installed

Two more tools were evaluated and left out of the manifest. Install them by hand, per project,
only when the conditions hold.

- **[Strix](https://github.com/usestrix/strix)** (autonomous penetration testing): `uv tool install strix-agent`.
  It needs Docker and its own LLM API key, and it mounts the target folder writable. Run it only on
  a throwaway copy of code you own, with a key that has a spending cap, and never on regulated
  client code. Do not add its skills globally: a skill that fires by itself for every security request would
  compete with the `security-and-hardening` skill.
- **[21st](https://github.com/21st-dev/claude-code-plugin)** (UI component registry): a remote MCP
  server plus skills, with an API key. Enable it in a frontend project, never globally and never
  in a folder with client code, with a key you can revoke.

## Deliberately not shipped

Some pieces stay on the machine that owns them:

- hooks that encode personal or org-specific facts, such as the GitHub account guard or guards
  that hardcode project folders;
- the global `CLAUDE.md`;
- `settings.json` env values.

If the other machine needs them, write them there by hand.

## Tests

```bash
python3 -I agentic-env/test_install.py               # installer, against a throwaway HOME
python3 -I agentic-env/test_plugins.py               # plugin checks, against a stand-in claude
python3 -I agentic-env/test_tools.py                 # external tools, against a stand-in uv
python3 -I agentic-env/test_library_docs.py          # library-docs, against a stand-in Context7
python3 -I scripts/test_vendor_agent_skills.py       # the vendored agent-skills plugin
for t in agentic-env/hooks/test_*.py; do python3 -I "$t"; done
```
