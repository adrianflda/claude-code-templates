# agent-skills (vendored)

The skills of [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) by Addy
Osmani, MIT licensed (see [`LICENSE`](LICENSE)), copied at a pinned commit. The text of every skill
is upstream's, unchanged. This copy differs from installing upstream's plugin in three ways:

- **Pinned.** [`VENDOR.json`](VENDOR.json) names the version and commit. Nothing updates until
  someone changes it and reviews the diff.
- **Skills only.** Upstream's commands, agents and hook scripts are not taken. The commands only
  forward to a skill, the agents repeat ones this environment already has, and no hook is wired.
- **Curated.** Six skills are `active`: Claude may use them on its own when the task matches.
  The other twenty carry `disable-model-invocation: true`, so they cost no context and run only
  when you type their name.

## Install

`agentic-env/install.py` installs it with the rest of the environment. On its own:

```
/plugin install agent-skills --marketplace adrianflda/claude-code-templates
```

## Why most skills are user-only

Claude Code offers no setting that hides a single skill of a plugin (`skillOverrides` does not
apply to plugin skills), so the choice has to live in the skill's own frontmatter.

The rule behind the choice: two things must not start on their own for the same kind of task.
Spec, plan, build, test, review and ship already belong to `quality-kernel` and `pre-push-review`
in this environment, which enforce them with gates rather than describe them. The upstream skills
for those phases stay available by name as a second opinion. The active ones cover ground nothing
else here covers.

| Active | What it brings |
|---|---|
| `debugging-and-error-recovery` | Reproduce, localize, reduce, fix, guard, verify |
| `api-and-interface-design` | Contracts, idempotency keys, pagination, versioning |
| `security-and-hardening` | Threat modelling at build time, OWASP and LLM-feature rules |
| `deprecation-and-migration` | Expand/contract schema migrations, sunsetting code |
| `performance-optimization` | Measure first, keep or revert, budgets |
| `observability-and-instrumentation` | Structured logs, RED/USE metrics, tracing, alerts |

To run a user-only skill: `/agent-skills:<name>`, for example `/agent-skills:interview-me`.

## Taking a new upstream release

```bash
# 1. set "version" and "commit" in VENDOR.json to the new tag and its full commit SHA
python3 -I scripts/vendor_agent_skills.py        # refuses if upstream added a skill or wired a hook
git diff plugins/agent-skills                    # read what changed: skill text is instructions
python3 -I scripts/test_vendor_agent_skills.py
```

A new upstream skill has to be added to `active` or `userOnly` before the script will run.
Bump the `version` of the `agent-skills` entry in `.claude-plugin/marketplace.json` to match.

Some user-only skills run tools on demand when you invoke them (for example
`accessibility-engineering` runs `npx` packages against a URL you give it). Read a skill before
using it on a machine that holds client code.
