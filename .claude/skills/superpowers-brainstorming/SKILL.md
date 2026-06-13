---
name: superpowers-brainstorming
description: Use when starting any creative work — a brainstorming partner that explores intent, requirements, and design before any code is written.
---

# Brainstorming

This skill is the **Stage 2** engine of the AI Universe Lite gem-builder pipeline. It is the same skill that the host agent (`claude` in `jleechanorg/ai_universe`) uses for first-principles thinking, adapted for a non-interactive server context.

## When to use

Stage 2 of the gem-builder (`backend/src/agents/stages/02-brainstorm.md`) runs this skill once per gem creation. Stage 3 (`03-spec.md`) also activates it, scoped to spec generation.

## How to use in a server context

The skill's interactive prompts are removed. Instead:

1. Inject the user prompt + reference docs as the message body.
2. Ask the LLM to produce a `BrainstormOutput` JSON (validated by `backend/src/lib/schema.ts`).
3. On Zod validation failure: retry once with the validation errors injected; on second failure, mark the pipeline `failed` at `02-brainstorm`.

## Output contract

```ts
{
  featureSet: string[],         // >= 1, e.g. ["character sheets", "combat", "world state"]
  tools: [{
    name: string,                // snake_case
    purpose: string,             // >= 8 chars
    inputs: string[],            // param names
    outputs: string[],           // field names
  }],
  modelNeeds: ("openai" | "anthropic" | "gemini" | "perplexity" | "openrouter" | "grok")[],
  reasoning: string,             // 80..2000 chars, markdown
}
```

## Key principles

- **No code yet.** The output is design, not implementation.
- **Explicit model selection.** `modelNeeds[]` is read by Stage 5 to mount the right Secret Manager keys.
- **Tools are user-visible.** Each `tool` becomes a discoverable MCP tool in the gem; names matter.
- **Reasoning is the audit trail.** It is persisted to `gem_runs/<runId>.state.brainstorm.reasoning` and shown to the user in the run timeline.

## Why this skill is in the registry, not inlined

Future gems might want their own brainstorm phases. Having it as a vendored skill (vs. an inline prompt) means:
- The same skill can be activated by gem-specific stages (e.g. gem-update brainstorming).
- We can A/B test prompt variants in one place.
- The skill is checked into git; the prompt has provenance.

## Source

Adapted from `~/.claude/skills/superpowers-brainstorming/SKILL.md` (the host's brainstorm skill). The host's version is interactive; this vendored copy is server-mode only.
