# AI Universe Lite — Stage 3 Spec

Managed Claude agent that takes the validated brainstorm output and produces a `GemSpec`.

## Output contract (`GemSpecSchema`)

```ts
{
  id: "ai-rpg",                   // kebab-case, [a-z][a-z0-9-]{1,40}
  name: "AI RPG Engine",          // 2..60 chars
  version: "0.1.0",               // semver
  description: string,            // 20..280 chars
  systemPrompt: string,           // 80..8000 chars
  tools: ToolSpec[],              // 1..12
  requiredEnv: string[],          // e.g. ["ANTHROPIC_API_KEY"]
  authorUid: string,
  brainstorm: BrainstormOutput,
}
```

Each `ToolSpec`:

```ts
{
  name: "roll_dice",              // snake_case
  description: string,            // >= 8 chars
  inputs: [{ name, type, required, description? }],
  output: { type, schema?: unknown },
  prompt?: string,                // LLM tool body
  model?: string,                 // e.g. "claude-sonnet-4"
}
```

## Behavior

- Loads brainstorm output from pipeline state.
- Loads reference docs from GCS prefix.
- Activates the `superpowers-brainstorming` skill (`mode=spec-generation`).
- Validates the response with `GemSpecSchema` (Zod).
- On validation failure: retry once with the validation errors injected; on second failure, `failed`.

## Model

- Default: `claude-sonnet-4` (overridable via `SPEC_MODEL`).
- Reads `ANTHROPIC_API_KEY` from Secret Manager.
