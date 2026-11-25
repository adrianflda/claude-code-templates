# dev-toolbox

One install for daily software work. The plugin is a bundle: it declares the other plugins of this
marketplace as dependencies, so Claude Code installs and enables them with it, and it adds the
stack skills that used to live as loose folders in `~/.claude/skills`.

```bash
claude plugin marketplace add adrianflda/claude-code-templates
claude plugin install dev-toolbox@adrianflda-claude-code-templates
```

`python3 -I agentic-env/install.py` does the same and also installs what a plugin cannot carry
(the hooks wired in `settings.json`, the agents, the `graphify` CLI).

## What comes with it

| Need | Piece | Where it lives |
|---|---|---|
| Development cycle from a ticket or a description, with tests first and a gate | `/forge`, `/develop`, `/gate` | `quality-kernel` (dependency) |
| Review on every push, quick mode for small changes | expert panel | `pre-push-review` (dependency) |
| Spend control: report, doctor, audit, spawn budget, context watchdog | `/usage-guard` | `usage-guard` (dependency) |
| Pull requests stay drafts; AWS admin actions need a human | hooks | `pr-draft-guard`, `aws-admin-guard` (dependencies) |
| Debugging, API design, security while building, migrations, performance, observability | skills | `agent-skills` (dependency) |
| TypeScript on Node, React, Next.js | `nodejs-best-practices`, `react-best-practices`, `nextjs-best-practices` | this plugin |
| Python | `python-patterns` | this plugin |
| Containers and servers | `docker-expert`, `server-management` | this plugin |
| AWS serverless | `aws-serverless` | this plugin |
| LLM agents, tool design, prompt caching, OpenAI docs, voice agents | `ai-agents-architect`, `agent-tool-builder`, `prompt-caching`, `openai-docs`, `voice-ai-development` | this plugin |
| Test plans and regression suites | `qa-test-planner` | this plugin |
| A structured debate before a decision | `think-tank` | this plugin |
| Isolated work on a branch | `using-git-worktrees` | this plugin |

A skill of this plugin is invoked as `dev-toolbox:<name>`. A machine that still has the same skill
as a folder in `~/.claude/skills` would list it twice: remove the folder after installing.

## Not in it yet

- Google Cloud, OpenTofu, Playwright and interface motion. Each has a widely used source
  ([google/skills](https://github.com/google/skills),
  [antonbabenko/terraform-skill](https://github.com/antonbabenko/terraform-skill), Playwright's own
  CLI skills, [emilkowalski/skills](https://github.com/emilkowalski/skills)); they come in vendored
  at a pinned commit, the way `agent-skills` was, once each has been read in full.
- Agents. They are installed by `agentic-env/install.py` and stay there until it is decided which
  of them earn a place.
- Plugins of other marketplaces (`cc-safety-net`, `claude-mem`): a bundle cannot pull them in
  without an allowlist entry, and they are a machine-level choice.

## Where the skills come from

The fifteen skills are the copies in daily use on the author's machine. Thirteen of them started
as the skills of the same name under `cli-tool/components/skills` and were edited since (shorter
descriptions, corrected examples); `react-best-practices` is Vercel's `vercel-react-best-practices`.
