# AI Universe Lite — Stage 2 Brainstorm

Managed Claude agent that produces a `BrainstormOutput` from the prompt + ref bundle.

## Behavior

- Loads the system prompt and reference docs from the intake GCS prefix.
- Activates the `superpowers-brainstorming` skill (vendored in `.claude/skills/`).
- Produces:
  - `featureSet: string[]` (>= 1)
  - `tools: { name, purpose, inputs[], outputs[] }[]`
  - `modelNeeds: ("openai" | "anthropic" | "gemini" | "perplexity" | "openrouter" | "grok")[]`
  - `reasoning: string` (markdown, 80..2000 chars)
- Returns the validated `BrainstormOutput` (Zod).

## LLM config

- Default model: `claude-sonnet-4` (overridable via `BRAINSTORM_MODEL`).
- Reads `ANTHROPIC_API_KEY` from Secret Manager (never env var).
- Two attempts; on second failure, pipeline `failed` with `stage="02-brainstorm"`.

## Why this is a managed agent

Brainstorm requires LLM judgment (scope, naming, model selection). Deterministic templates cannot do this well — the user's whole point is "make it from a prompt."

## Why a separate brainstorm stage (vs. merge with spec)

- Brainstorm = WHAT we want; spec = HOW to implement.
- Two checkpoints: user can edit the brainstorm before spec is generated (future: "human-in-the-loop" mode).
- Brainstorm output becomes the spec's `featureSet` and `tools[]` — explicit data flow.
