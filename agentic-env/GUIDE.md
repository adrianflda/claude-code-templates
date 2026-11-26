# What is installed and when to use it

After [`SETUP.md`](SETUP.md) has run, the machine has the pieces below. Most of them need
nothing from you: they act at a fixed moment. The first table is the one to remember.

## By situation

| You want to | Do this | What runs |
|---|---|---|
| Build a feature from a ticket or a paragraph | `/forge <ticket or description>` | `quality-kernel`: contract, design options for you to pick, tests first, code, cleanup, gate. It scales the steps to the size of the task. |
| Build a small app from one description | `/develop <description>` | `quality-kernel`: a short plan, one approval, then it builds and verifies on its own. |
| Know whether the current change is safe to ship | `/gate` | `quality-kernel`'s deterministic gate: it re-runs the checks itself and gives a verdict. |
| Check existing code against a list of requirements | `/requirements-gap` | A coverage map: met, partial, missing, with evidence. Read-only. |
| Push | `git push` | `pre-push-review` runs by itself: a panel of reviewers reads the diff and blocks only on serious findings. Small pushes get a quick panel. |
| Review before pushing, on demand | `/pre-push-review` | The same panel, on staged changes, a branch or a pull request. |
| See where the plan's usage goes, or reduce it | `/usage-guard report`, `doctor`, `audit` | `usage-guard`: cost by session, by agent type and by plugin, and settings that waste tokens. |
| Find out why something is broken | `/diagnose`, or just describe the bug | `/diagnose` forces probing the real system first; the `debugging-and-error-recovery` skill loads by itself. |
| Decide between real alternatives | "think tank: X or Y" | `think-tank`: a structured debate that ends in a trade-off analysis. Skip it for cheap, reversible choices. |
| Look up a library's current API | ask normally | `library-docs` fetches current docs from Context7. |
| Understand an unfamiliar repository or plan a refactor | ask "what calls X" / "what does changing X affect" | `code-graph` builds a local graph with `graphify`. No LLM, nothing leaves the machine. |
| Get an independent opinion on finished work | "ask the adversarial critic", "security audit" | An agent with its own context: `adversarial-critic`, `pipeline-breaker`, `security-auditor`, `architect-reviewer`, `code-reviewer`. |
| Research without flooding the conversation | "have the researcher look into X" | `researcher`: read-only, five tools, a short fixed report. |
| Draw an architecture or flow as an interactive page | per project: `add_archify.py <project>`, then `/archify` | Archify, installed in that project only. |

## Skills that load by themselves

You do not call these; Claude loads one when the task matches its description. The stack skills
come from the `dev-toolbox` plugin, the building skills from `agent-skills`, the rest from the
installer.

| Area | Skills |
|---|---|
| TypeScript, React, Next.js | `nodejs-best-practices`, `react-best-practices`, `nextjs-best-practices` |
| Python | `python-patterns` |
| Containers, servers | `docker-expert`, `server-management` |
| AWS, Google Cloud, OpenTofu | `aws-serverless`, `gcloud`, `opentofu` |
| Tests in the browser | `playwright-suite` |
| Interface design and motion | `frontend-design`, `emil-design-eng` |
| LLM applications | `ai-agents-architect`, `agent-tool-builder`, `prompt-caching`, `openai-docs`, `voice-ai-development` |
| While building | `debugging-and-error-recovery`, `api-and-interface-design`, `security-and-hardening` and the other active skills of `agent-skills` |
| Working method | `epistemic-discipline`, `qa-paradigms`, `using-git-worktrees`, `think-tank` |

## Skills you type

These run only when typed, so that two skills never compete for the same task. Type
`/dev-toolbox:<name>`:

`playwright-cli` (drive a browser, write one test), `terraform-skill`, `mcp-builder`,
`qa-test-planner`, `web-design-guidelines`, `pick-ui-library`, the motion set (`animate`,
`animation-performance`, `gestures`, `mobile-native`, `review-animations`, `choreograph`,
`break-ui`), and Google Cloud (`google-cloud-recipe-auth`, `cloud-run-basics`, `cloud-sql-basics`,
`gke-basics`, `gcp-secret-manager`, `gcp-pubsub`). The user-only skills of `agent-skills` are
typed as `/agent-skills:<name>`.

## Guards: what can stop you, and why

| Guard | When it acts | What it does |
|---|---|---|
| `pr-draft-guard` | `gh pr create`, `gh pr ready` | Pull requests are opened as drafts; marking one ready is a human decision. |
| `aws-admin-guard` | AWS commands with admin effect | Stops and asks for a human. |
| `dangerous-command-blocker` | any shell command | Blocks only catastrophic, irreversible commands. |
| `secret-scanner` | `git commit` | Refuses a commit that contains a hardcoded secret. |
| `conventional-commits` | `git commit -m` | The message must start with `type(scope): description`. |
| `spanish-gate` | `git push`, `gh pr create` | Blocks a push that adds Spanish to committed files (the repository language is English). |
| `resource-guard` | builds, Playwright, dev servers | Warns when memory is tight before a heavy command. |
| `epistemic-observe-guard` | session start | Reminds Claude to run the check before stating a fact about the system. |
| `usage-guard` | spawning agents, long sessions | A budget on agent spawns and a watchdog on context size. |
| `pre-push-review` | `git push` | See the first table. |

When a guard blocks, the message says which rule and why. Fix the cause; a bypass
(`git push --no-verify`) skips the review that was the point.

## Rules that keep it cheap

- Build in the main session with skills. Use an agent for an independent check or for work that
  would flood the context, not for building.
- One orchestrator: `quality-kernel`. Do not add another framework that plans and spawns.
- Do not run a second review before a push: the push runs one.
- A read-only question for an agent goes to `researcher`, not to a general-purpose agent.

These four are the "Which tool for which job" block in [`README.md`](README.md); they belong in
the machine's global `CLAUDE.md`.

## Keeping it current

`git pull`, then `python3 -I agentic-env/install.py` and `python3 -I agentic-env/install.py --check`.
The check prints `OK: in sync with the repo` or the list of what differs.
