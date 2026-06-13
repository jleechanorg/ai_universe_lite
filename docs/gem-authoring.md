# Authoring a Gem by Hand

Most gems are created via `scripts/create-gem.sh` (the 8-stage pipeline). This doc covers how to write a gem by hand for cases where the pipeline can't get there (very domain-specific tool logic, custom code outside the template, etc.).

## When to Author by Hand

- The pipeline generates a gem that works, but you need to add custom code that doesn't fit the template.
- You're iterating on a gem and want to skip stages 2-3 (you already have a spec).
- You're building a v1 reference gem like `ai-rpg`.

## Directory Layout

```
gems/<gem-id>/
  package.json
  tsconfig.json
  src/
    server.ts              # FastMCP entry; auto-loads tools/
    tools/
      <tool_name>.ts       # one per ToolSpec; default export = FastMCP tool
    references.ts          # loader for GCS-mounted refs (optional)
    config.ts              # GEM_ID, GEM_VERSION, REF_BUCKET from env
  __tests__/
    <tool_name>.test.ts    # per-tool unit tests
  Dockerfile.gem
  cloudbuild.gem.yaml
  deploy.gem.sh
  README.md
  .env.example
```

## Minimum Viable Gem

`package.json`:
```json
{
  "name": "@ai-universe-lite/gem-<id>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "type-check": "tsc --noEmit",
    "lint": "eslint src",
    "test": "jest"
  },
  "dependencies": {
    "@ai-universe/mcp-server-utils": "*",
    "@ai-universe/gem-runtime": "*",
    "fastmcp": "^1.0.0",
    "zod": "^3.22.0"
  }
}
```

`src/server.ts`:
```ts
import { FastMCP } from "fastmcp";
import { loadGemContext } from "@ai-universe/gem-runtime";
import { config } from "./config.js";

const ctx = loadGemContext({
  gemId: config.gemId,
  gemVersion: config.gemVersion,
  systemPrompt: GEM_SYSTEM_PROMPT, // from spec
});

const server = new FastMCP({ name: ctx.gemId, version: ctx.gemVersion });

// Auto-discover tools in src/tools/*.ts
for await (const tool of import.meta.glob("./tools/*.ts", { eager: true })) {
  if (typeof tool.default === "function") {
    server.addTool(tool.default(ctx));
  }
}

server.start({ transportType: "httpStream", port: config.port });
```

`src/tools/<tool_name>.ts`:
```ts
import { z } from "zod";
import type { GemContext } from "@ai-universe/gem-runtime";

const InputSchema = z.object({
  /* ... */
});

export default (ctx: GemContext) => ({
  name: "tool_name",
  description: "...",
  parameters: InputSchema,
  execute: async (params: z.infer<typeof InputSchema>) => {
    // Use ctx.systemPrompt, ctx.refs, ctx.callLlm, etc.
    return { content: [{ type: "text", text: "..." }] };
  },
});
```

## Deploy Manually

```bash
cd gems/<id>/
./deploy.gem.sh dev      # local dev deploy
# or
./deploy.gem.sh prod     # BLOCKED locally; use gem-publish.yml
```

## Adding to the Registry

If you wrote the gem by hand, register it:

```bash
./scripts/register-gem.sh gems/<id>/package.json
```

This is just a thin wrapper around Stage 7 Publish — it reads `package.json` for metadata, prompts for `shareToken` rotation if needed, and writes the Firestore entry.

## Style Guide

- All input validation via Zod. No `any` in tool inputs.
- One tool per file. Default export = the tool factory.
- Use `ctx.callLlm("claude-sonnet-4", prompt)` for LLM calls — never instantiate Anthropic/OpenAI clients directly.
- Use `ctx.refs` for any reference-doc lookups; never read GCS directly.
- Tests live in `__tests__/`, one file per tool, named `<tool_name>.test.ts`.
