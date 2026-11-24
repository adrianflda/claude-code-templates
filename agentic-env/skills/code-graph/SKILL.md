---
name: code-graph
description: Builds and queries a local structural graph of a codebase with the graphify CLI (who calls what, what a change affects, how two symbols connect). Use before a refactor or when orienting in an unfamiliar or multi-module repository, and when graphify-out/ already exists. Not for a question one grep answers.
---

# Code graph

`graphify` parses source files locally with tree-sitter and writes a graph you can query. The
commands below use no LLM and send nothing off the machine.

If `graphify` is not on `PATH`, say so and stop: it is installed by `agentic-env/install.py`
(`uv tool install graphifyy`), not from here.

## Steps

1. Build or refresh the graph from the repository root (seconds, incremental):

   ```bash
   graphify update .
   ```

   Keep the output out of version control:

   ```bash
   git check-ignore -q graphify-out || echo 'graphify-out/' >> .gitignore
   ```

2. Read `graphify-out/GRAPH_REPORT.md` first. It lists the subsystems, the most connected nodes
   and the surprising connections; that is usually enough to know where to look.

3. Ask precise questions. Each answer cites file and line:

   ```bash
   graphify explain "pause()"                     # a node and its neighbours
   graphify path "pause()" "write_json()"         # shortest path between two nodes
   graphify affected "read_json()"                # what depends on this node
   graphify god-nodes                             # architectural hubs
   ```

   A name that matches several nodes exits `3` and lists them; repeat with the exact one.
   `graphify query "<question>"` does a broad traversal and can print thousands of tokens: use it
   only when the three commands above do not answer.

4. Then read the files the graph pointed to. An edge marked `EXTRACTED` was parsed from the code;
   one marked `INFERRED` is a guess with a confidence score, so confirm it in the source.

## Do not run

- `graphify install`, `graphify claude install`, `graphify hook install`: they edit the global
  or project `CLAUDE.md`, install another skill, or add git hooks.
- `graphify add`, `clone`, `extract`, `label`, `watch`, `global`: they fetch from the network,
  call an LLM backend, or keep running in the background.

If one of these is really needed, ask the user first.
