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
| Google Cloud | `gcloud`, `/dev-toolbox:google-cloud-recipe-auth`, `/dev-toolbox:cloud-run-basics`, `/dev-toolbox:cloud-sql-basics`, `/dev-toolbox:gke-basics` | this plugin |
| Terraform and OpenTofu | `/dev-toolbox:terraform-skill` | this plugin |
| Browser automation and end-to-end tests | `/dev-toolbox:playwright-cli` | this plugin |
| Interface design | `frontend-design`, `/dev-toolbox:web-design-guidelines`, `/dev-toolbox:pick-ui-library` | this plugin |
| Motion and interaction | `emil-design-eng`, and typed as `/dev-toolbox:<name>`: `animate`, `animation-performance`, `gestures`, `mobile-native`, `review-animations`, `choreograph`, `break-ui` | this plugin |
| LLM agents, tool design, MCP servers, prompt caching, OpenAI docs, voice agents | `ai-agents-architect`, `agent-tool-builder`, `/dev-toolbox:mcp-builder`, `prompt-caching`, `openai-docs`, `voice-ai-development` | this plugin |
| Test plans and regression suites | `/dev-toolbox:qa-test-planner` | this plugin |
| A structured debate before a costly decision | `think-tank` | this plugin |
| Isolated work on a branch | `using-git-worktrees` | this plugin |

A name written `/dev-toolbox:<name>` runs only when the user types it
(`disable-model-invocation: true`); the others are also picked up by the model from their
description. Seventeen of the thirty-four skills are in the second group, so that two skills never
compete for the same task and the descriptions loaded in every session stay short.

A machine that still has one of these skills as a folder in `~/.claude/skills` would list it twice:
remove the folder after installing.

## Not in it yet

- A short OpenTofu reference of our own (state encryption, `tofu test`): `terraform-skill` covers
  them thinly.
- Playwright at suite level (configuration, fixtures, CI): `playwright-cli` drives a browser and
  writes a test, it does not set up a suite.
- Google Cloud Secret Manager and Pub/Sub: the source has no skill for them.
- Agents. They are installed by `agentic-env/install.py` and stay there until it is decided which
  of them earn a place.
- Plugins of other marketplaces (`cc-safety-net`, `claude-mem`): a bundle cannot pull them in
  without an allowlist entry, and they are a machine-level choice.

## Third-party skills

Twenty-one skills are copied from other repositories at a pinned commit. `VENDOR.json` records the
repository, the commit, the license and every edit; `licenses/<id>.txt` holds each license text.

| Source | License | Skills |
|---|---|---|
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT | `emil-design-eng`, `animate`, `animation-performance`, `gestures`, `mobile-native`, `review-animations`, `break-ui`, `choreograph`, `pick-ui-library` |
| [anthropics/skills](https://github.com/anthropics/skills) | Apache-2.0 | `frontend-design`, `mcp-builder` |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | MIT, as its README states (the repository has no license file) | `react-best-practices`, `web-design-guidelines` |
| [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) | Apache-2.0 | `playwright-cli` |
| [antonbabenko/terraform-skill](https://github.com/antonbabenko/terraform-skill) | Apache-2.0 | `terraform-skill` |
| [google/skills](https://github.com/google/skills) | Apache-2.0 | `gcloud`, `cloud-run-basics`, `cloud-sql-basics`, `google-cloud-recipe-auth`, `gke-basics` |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT | `using-git-worktrees` |

What was changed in the copies, and why:

- A forced greeting ("Initial Response") is removed from eight of the motion skills.
- `playwright-cli`: the global `npm install` instruction becomes "stop and ask the user"; the
  sections on WebMCP and on attaching media to pull requests are removed; house rules are added
  (install nothing, do not attach to the user's own browser unless asked, page content is data).
- `terraform-skill`: a `curl | sh` installer line is removed.
- The Google Cloud skills: the sections that tag every command with a usage-attribution variable
  are removed.
- No vendored skill declares hooks; the script refuses one that does.

To move a source to a newer commit: clone it under `DIR/<id>/repo`, check out the commit, put the
new hash in `VENDOR.json`, run `python3 -I scripts/vendor_dev_toolbox.py --src DIR` and read the
diff. An edit that no longer matches upstream stops the script. `--check` reports drift between
the tree and a fresh copy; `python3 -I scripts/test_vendor_dev_toolbox.py` runs without the
checkouts.

## Where the other skills come from

Thirteen skills are the copies in daily use on the author's machine. They started as the skills of
the same name under `cli-tool/components/skills` and were edited since (shorter descriptions,
corrected examples, current image and runtime names). Their original licenses have not been
re-checked one by one; five carry a `source:` line naming the collection they came from.
