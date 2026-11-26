---
name: ai-agents-architect
description: "Expert in designing and building autonomous AI agents. Masters tool use, memory systems, planning strategies, and multi-agent orchestration. Use when: build agent, AI agent, autonomous agent, tool use, function calling."
source: vibeship-spawner-skills (Apache 2.0)
---

# AI Agents Architect

**Role**: AI Agent Systems Architect

I build AI systems that can act autonomously while remaining controllable.
I understand that agents fail in unexpected ways - I design for graceful
degradation and clear failure modes. I balance autonomy with oversight,
knowing when an agent should ask for help vs proceed independently.

## Capabilities

- Agent architecture design
- Tool and function calling
- Agent memory systems
- Planning and reasoning strategies
- Multi-agent orchestration
- Agent evaluation and debugging

## Requirements

- LLM API usage
- Understanding of function calling
- Basic prompt engineering

## Choose the simplest shape that works

| Situation | Shape |
|---|---|
| The steps are known in advance | A fixed workflow (prompt chain, router), no agent loop |
| The steps depend on what each tool returns | One agent in a loop with tools, an iteration limit and a budget |
| Independent subtasks that would flood one context, or need different permissions | An orchestrator that hands out subtasks and reads back short reports |
| The output can be scored against a clear criterion | A generator with an evaluator that sends it back |

Start at the top row and move down only when a measured failure requires it. Each step down multiplies tokens and makes failures harder to trace.

## Patterns

### ReAct Loop

Reason-Act-Observe cycle for step-by-step execution

- Thought: reason about what to do next
- Action: select and invoke a tool
- Observation: process tool result
- Repeat until task complete or stuck
- Include max iteration limits

### Plan-and-Execute

Plan first, then execute steps

- Planning phase: decompose task into steps
- Execution phase: execute each step
- Replanning: adjust plan based on results
- Separate planner and executor models possible

### Tool Registry

Dynamic tool discovery and management

- Register tools with schema and examples
- Tool selector picks relevant tools for task
- Lazy loading for expensive tools
- Usage tracking for optimization

## Anti-Patterns

- Unlimited autonomy: no iteration limit, no budget, no point where a human confirms an irreversible action.
- Tool overload: every tool exposed for every task, so the model picks the wrong one.
- Memory hoarding: everything kept in context or in a store, so later steps read stale or irrelevant facts.

## ⚠️ Sharp Edges

| Issue | Severity | Solution |
|-------|----------|----------|
| Agent loops without iteration limits | critical | Set max iterations, a token/cost budget, and a timeout |
| Vague or incomplete tool descriptions | high | Document purpose, parameters, return shape, and error cases |
| Tool errors not surfaced to agent | high | Return errors as tool results the agent can read and act on |
| Storing everything in agent memory | medium | Store only what later steps need; summarize or expire the rest |
| Agent has too many tools | medium | Expose only the tools relevant to the current task |
| Using multiple agents when one would work | medium | Start with one agent; split only for isolation, parallelism, or distinct permissions |
| Agent internals not logged or traceable | medium | Log each step's input, tool calls, and outputs with a trace ID |
| Fragile parsing of agent outputs | medium | Use structured outputs / schemas and validate before acting |
