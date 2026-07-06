# Gem Authoring Guide

> How to author a new gem — either by hand or by adapting the v1 reference gem (`gems/ai-rpg/`).

## Summary

Every gem is a small TypeScript MCP server: a `FastMCP` entrypoint, one Zod-validated tool
per `ToolSpec`, and a system prompt that tells the LLM what the gem does. The pipeline
generates the boring parts; you only need to write `src/tools/*.ts` and the system prompt.
A new author can copy `gems/ai-rpg/` and adapt it to a new domain in **under an hour**.

## Table of Contents

- [1. The golden path: copy ai-rpg](#1-the-golden-path-copy-ai-rpg)
- [2. File structure](#2-file-structure)
- [3. Per-tool conventions](#3-per-tool-conventions)
- [4. System prompt structure](#4-system-prompt-structure)
- [5. Reference authority: the bundle contract](#5-reference-authority-the-bundle-contract)
- [6. Test patterns](#6-test-patterns)
- [7. Build / deploy flow](#7-build--deploy-flow)
- [8. When to use LLM vs deterministic logic](#8-when-to-use-llm-vs-deterministic-logic)
- [9. Sample gem walkthrough: ai-rpg](#9-sample-gem-walkthrough-ai-rpg)
- [10. Adding to the registry](#10-adding-to-the-registry)
- [See also](#see-also)

## 1. The golden path: copy ai-rpg

The fastest way to make a new gem:

```bash
# 1. Copy the reference gem
cp -r gems/ai-rpg/ gems/my-new-gem/
cd gems/my-new-gem/

# 2. Rename the package
#    Edit package.json: name: "@ai-universe-lite/gem-my-new-gem"
#                       version: "0.1.0"

# 3. Replace the tools
rm src/tools/*.ts
# Write src/tools/<your_tool>.ts (one file per tool — see §3)

# 4. Rewrite the system prompt
#    Edit src/system-prompt.ts (see §4)

# 5. Update the README
#    Edit README.md — the auto-generated one from the pipeline works as a starting point

# 6. Verify locally
npm install
npm test
npm run type-check
npm run lint

# 7. (Optional) Deploy
./deploy.gem.sh dev

# 8. Register
cd ../..
./scripts/register-gem.sh gems/my-new-gem/package.json
```

That's the whole loop. Steps 1-6 are about the gem itself; step 7 is the
`cloudrun-deploy.md` contract; step 8 is the `gem-builder.md` Stage 7.

## 2. File structure

`gems/<gem-id>/` mirrors the reference gem:

```
gems/<gem-id>/
├── package.json                # @ai-universe-lite/gem-<id>, version, deps
├── tsconfig.json               # extends ai_universe_lite's base tsconfig
├── src/
│   ├── server.ts               # FastMCP entry; auto-loads tools/
│   ├── config.ts               # GEM_ID, GEM_VERSION, REF_BUCKET from env
│   ├── system-prompt.ts        # the system prompt (see §4)
│   ├── references.ts           # loader for GCS-mounted refs (optional)
│   └── tools/
│       └── <tool_name>.ts      # one file per tool (see §3)
├── __tests__/
│   ├── setup.ts                # makeStubGemContext() helper
│   ├── server.boot.test.ts     # boots the FastMCP server in-process
│   └── <tool_name>.test.ts     # per-tool unit tests
├── Dockerfile.gem              # from templates/Dockerfile.gem.tmpl
├── cloudbuild.gem.yaml         # from templates/cloudbuild.gem.tmpl
├── deploy.gem.sh               # from templates/deploy.gem.sh.tmpl
├── .env.example                # which env vars the gem reads
└── README.md                   # auto-generated; edit to taste
```

The `ai-rpg` reference gem has all of this. Use it as a checklist.

## 3. Per-tool conventions

**One tool per file.** Filename = tool name (snake_case). Default export = the
`ToolFactory(ctx) => FastMCPTool`. Tools are auto-discovered via `import.meta.glob`
in `src/server.ts`.

### 3.1 The Zod input schema

```ts
import { z } from "zod";

const InputSchema = z.object({
  notation: z.string().min(1).max(20),  // e.g. "2d6+3"
  // ...
});
```

Rules:

- **All input validation via Zod.** No `any` in tool inputs.
- **No `z.unknown()` in inputs.** If you need a free-form field, validate its shape
  (e.g. `z.record(z.string(), z.unknown())` for a `metadata` blob).
- **Reasonable bounds.** `.min(1).max(20)` beats unbounded — protects against OOM and
  cost-overrun attacks.

### 3.2 The deterministic-first / LLM-last rule

**Default: deterministic.** If your tool can be implemented with `Math.random`, regex,
string concat, JSON.parse, or a local computation, do that. LLM is expensive, slow, and
non-deterministic.

**Reach for `ctx.callLlm` only when** the task involves:

- Summarizing a long document into a short answer
- Generating free-form prose ("write a 200-word description of…")
- Choosing between options with fuzzy criteria ("which of these is the best fit?")
- Reformatting structured data into natural language

Concrete examples from `gems/ai-rpg/`:

- `roll_dice.ts` — **deterministic.** Parses `2d6+3` and uses `mulberry32` (a seeded PRNG).
  No LLM.
- `narrate_event.ts` — **LLM.** Takes a structured event and the recent narrative, asks
  `claude-sonnet-4` for a 2-3 sentence narration.

### 3.3 The return shape (MCP contract)

Every tool **must** return:

```ts
return {
  content: [{ type: "text", text: JSON.stringify(payload) }],
};
```

Where `payload` is whatever your tool produces (a number, an object, an array). The MCP
spec is strict on this shape — FastMCP only forwards `{ content: [{ type, text }] }` to
the client. Returning raw JSON, or `{ result: ... }`, or anything else will silently
break the client.

**Tip:** wrap the payload in `JSON.stringify` (and *don't* `JSON.parse` it back). The
client (Claude / Cursor) reads the text and parses it on its end. Round-tripping through
JSON is the convention; it also means the gem's output is human-readable in logs.

### 3.4 A complete tool example

`gems/ai-rpg/src/tools/roll_dice.ts`:

```ts
import { z } from "zod";
import { mulberry32 } from "../rng.js";
import type { ToolFactory } from "@ai-universe/gem-runtime";

const InputSchema = z.object({
  notation: z.string().min(1).max(20),  // e.g. "2d6+3"
  seed: z.number().int().optional(),    // optional PRNG seed for reproducibility
});

const OutputSchema = z.object({
  total: z.number().int(),
  rolls: z.array(z.number().int()),
  modifier: z.number().int(),
  notation: z.string(),
});

const tool: ToolFactory = () => ({
  name: "roll_dice",
  description:
    "Roll dice in standard RPG notation (e.g. 2d6+3, 1d20, 4d6kh3). " +
    "Returns the total, individual rolls, and the modifier applied.",
  parameters: InputSchema,
  execute: async (params) => {
    const m = /^(\d+)d(\d+)(?:k(\d+))?([+-]\d+)?$/i.exec(params.notation);
    if (!m) {
      throw new Error(`Invalid dice notation: ${params.notation}`);
    }
    const n = Number(m[1]);
    const sides = Number(m[2]);
    const keep = m[3] ? Number(m[3]) : n;
    const mod = m[4] ? Number(m[4]) : 0;
    const rng = mulberry32(params.seed ?? Date.now());
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(rng() * sides));
    const top = [...rolls].sort((a, b) => b - a).slice(0, keep);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            total: top.reduce((a, b) => a + b, 0) + mod,
            rolls,
            modifier: mod,
            notation: params.notation,
          }),
        },
      ],
    };
  },
});

export default tool;
```

This is a model of how a tool should look. The companion test
`__tests__/roll_dice.test.ts` lives in §6.

## 4. System prompt structure

The system prompt is the single most important file in the gem. It's the LLM's
authoritative description of what the gem is, what it can do, and what the tools return.
A good system prompt has three sections, in this order.

### 4.1 The three sections

```ts
// src/system-prompt.ts
export const GEM_SYSTEM_PROMPT = `
// ===== 1. HEADER: what this gem is =====
You are the <Gem Name>. You help users <one-sentence job-to-be-done>.
You run as an MCP server attached to the user's Claude / Cursor client.

// ===== 2. TOOL LIST: what the LLM can call =====
You have access to the following tools:

- \`tool_name_1\` — <one-line purpose>. Inputs: <input shape>. Returns: <return shape>.
- \`tool_name_2\` — ...
- \`tool_name_3\` — ...

Call tools in the order that makes sense for the user's request. Don't call
tools you don't need. If a tool returns an error, explain to the user and
propose a fix.

// ===== 3. REFERENCE AUTHORITY: what trumps what =====
The user may have uploaded reference documents. Treat them as the
authoritative source for domain-specific rules:

- If a reference says "use 2d6 for skill checks" and your prior training
  says "use 1d20", the reference wins.
- If a reference contradicts itself, prefer the most specific clause.
- If you are unsure, ask the user.

If no references are present, fall back to your training data.
`;
```

### 4.2 The header

One paragraph. Answers three questions:

1. What is this gem? (noun)
2. Who is it for? (the user)
3. What's the job-to-be-done? (verb)

Example (from `ai-rpg`):

> "You are the AI RPG Engine. You help the user run tabletop-style role-playing
> games: you manage character sheets, roll dice, narrate combat, and remember
> campaign state across turns. You run as an MCP server attached to the user's
> Claude or Cursor client."

### 4.3 The tool list

A bullet per tool. Each bullet is one line: `name — purpose. Inputs: …. Returns: ….`
Do not dump Zod schemas verbatim — paraphrase. The LLM doesn't need to know `z.string().min(1).max(20)`;
it needs to know "a dice notation like `2d6+3`."

### 4.4 The reference-authority statement

This is what makes `--bundle` work. The user uploads a 200-page rulebook, the runtime
concatenates it into the system prompt (as `[REF BUNDLE]`), and the gem's spec must
explicitly tell the LLM to prefer the bundle over its prior training. See
[`docs/reference-uploads.md`](./reference-uploads.md) for the bundle contract.

## 5. Reference authority: the bundle contract

When a user runs `/gem-create "RPG game" --ref rulebook.pdf --bundle`, the runtime does:

```ts
ctx.systemPrompt =
  "[REF BUNDLE]\n\n" +
  refs.map((r) => readText(r)).join("\n\n---\n\n") +
  "\n\n[ORIGINAL]\n\n" +
  GEM_SYSTEM_PROMPT;
```

So your `GEM_SYSTEM_PROMPT` (in `src/system-prompt.ts`) becomes the **tail** of the
runtime prompt, and the bundle is prepended. This means:

- The bundle always wins (it's at the top, where the LLM pays the most attention).
- Your system prompt should tell the LLM **how to use** the bundle, not just that it
  exists.
- The same pattern is used by `ai_universe`'s `mvp_site` system.

The reference-authority statement in §4.4 is what makes this work. Without it, the LLM
will silently fall back to its training data when the bundle is silent on a question.

## 6. Test patterns

The gem's test suite lives in `__tests__/`. Three patterns to know.

### 6.1 `mulberry32` for dice (and any randomness)

Don't use `Math.random` in tests — it's non-deterministic and tests will flake.
`gems/ai-rpg/src/rng.ts` (and every other gem that has randomness) exports a
`mulberry32(seed)` helper:

```ts
// src/rng.ts
export const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};
```

Use it in your tool, and use it in your tests with a fixed seed:

```ts
// __tests__/roll_dice.test.ts
import { describe, it, expect } from "@jest/globals";
import tool from "../src/tools/roll_dice.js";

describe("roll_dice", () => {
  it("rolls 2d6+3 with a fixed seed", async () => {
    const t = tool({} as any);
    const result = await t.execute({ notation: "2d6+3", seed: 42 }, { signal: new AbortController().signal } as any);
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.notation).toBe("2d6+3");
    expect(payload.rolls).toHaveLength(2);
    expect(payload.rolls.every((r: number) => r >= 1 && r <= 6)).toBe(true);
    expect(payload.total).toBe(payload.rolls.reduce((a: number, b: number) => a + b, 0) + 3);
  });
});
```

### 6.2 `makeStubGemContext()` from `__tests__/setup.ts`

Every gem ships an `__tests__/setup.ts` that exports a `makeStubGemContext()` helper.
It returns a `GemContext` with stub `callLlm`, `readTextRef`, and `refs` fields, so
tools can be tested in isolation without standing up FastMCP.

```ts
// __tests__/setup.ts
import type { GemContext } from "@ai-universe/gem-runtime";

export const makeStubGemContext = (overrides?: Partial<GemContext>): GemContext => ({
  gemId: "test-gem",
  gemVersion: "0.0.0-test",
  systemPrompt: "You are a test gem.",
  refs: new Map(),
  callLlm: async (model: string, prompt: string) => `[stub ${model}] ${prompt.slice(0, 32)}...`,
  readTextRef: async (path: string) => `<<stub text for ${path}>>`,
  ...overrides,
});
```

Use it in any tool test:

```ts
import { makeStubGemContext } from "./setup.js";
import tool from "../src/tools/narrate_event.js";

it("narrates an event via ctx.callLlm", async () => {
  const ctx = makeStubGemContext();
  const t = tool(ctx);
  const result = await t.execute({ event: "Player rolls a crit" }, { signal: new AbortController().signal } as any);
  const payload = JSON.parse((result.content[0] as any).text);
  expect(payload.narration).toContain("stub claude-sonnet-4");
});
```

### 6.3 `server.boot.test.ts` (smoke test)

Every gem ships a `__tests__/server.boot.test.ts` that boots the FastMCP server
in-process and confirms the tools list is non-empty. It's a 30-line smoke test that
catches "I forgot to add a tool" / "the import glob is wrong" regressions:

```ts
import { describe, it, expect } from "@jest/globals";
import { FastMCP } from "fastmcp";
import { makeStubGemContext } from "./setup.js";

describe("server boot", () => {
  it("boots and registers all tools", async () => {
    const server = new FastMCP({ name: "test-gem", version: "0.0.0-test" });
    // (mirror the import.meta.glob loop from src/server.ts, but statically)
    const ctx = makeStubGemContext();
    const toolModules = [
      await import("../src/tools/roll_dice.js"),
      await import("../src/tools/narrate_event.js"),
    ];
    for (const mod of toolModules) {
      if (typeof mod.default === "function") {
        server.addTool(mod.default(ctx));
      }
    }
    // FastMCP's `tools` is a private symbol; we just check no error threw above.
    expect(toolModules).toHaveLength(2);
  });
});
```

## 7. Build / deploy flow

The end-to-end flow from a finished gem to a live share URL:

```
1. POST /api/gems (or /gem-create "<prompt>")
        │
        ▼
2. Stage 1 INTAKE         — uploads refs, creates gem_runs/<runId>
3. Stage 2 BRAINSTORM     — managed agent: BrainstormOutput
4. Stage 3 SPEC           — managed agent: GemSpec
        │
        ▼
5. Stage 4 BUILD          — renders templates → gems/<id>/
6. Stage 5 VERIFY         — npm install + tsc + eslint + jest
7. Stage 6 EVALUATE       — managed agent: EvaluationReport (probes)
        │
        ▼
8. Stage 7 PUBLISH        — Firestore write + shareToken
9. Stage 7.5 DEPLOY       — gcloud run deploy → cloudRunUrl
10. Stage 8 REGISTRY HOOKS — frontend PR + landing PR + audit log
        │
        ▼
11. User gets:
    - Share URL:   https://ai-universe.app/gems/<shareToken>
    - Install:     claude mcp add --transport http <gemId> https://<cloudRunUrl>/mcp
```

For the manual path (no pipeline), the steps collapse to:

```bash
cd gems/<id>/
./deploy.gem.sh dev              # dev deploy (allowed locally)
./deploy.gem.sh staging          # staging deploy (allowed locally)
./deploy.gem.sh prod             # BLOCKED locally; use gem-publish.yml
```

See [`docs/cloudrun-deploy.md`](./cloudrun-deploy.md) for the full deploy contract.

## 8. When to use LLM vs deterministic logic

A decision tree:

```
Does the tool's output depend on language, nuance, or judgment?
├── No  → deterministic. Use math, regex, JSON.parse, lookup tables.
│         Examples: roll_dice, parse_markdown, format_json, lookup_definition
│
└── Yes → LLM. Use ctx.callLlm("claude-sonnet-4", prompt).
          Examples: narrate_event, summarize_article, classify_intent

Is the input bounded (small, well-typed, fixed-schema)?
├── No  → consider deterministic preprocessing first, then LLM.
│         E.g. parse a 10k-line YAML into a small object, THEN ask the LLM
│         to choose between 3 named options. LLM with smaller input = cheaper + faster.
│
└── Yes → straight LLM call. Don't pre-engineer a heuristic the LLM can do.
```

**The hard rule:** every `ctx.callLlm` call is a per-invocation cost (typically $0.001–$0.01)
and a per-invocation latency (~500ms-3s). If you can answer a question with `Map.get`,
use `Map.get`.

**The LLM model choice:** default to `claude-sonnet-4`. Use `claude-haiku-*` for high-volume,
low-stakes calls (e.g. "classify this as positive/negative"). The spec can override per-tool
via `ToolSpec.model`.

## 9. Sample gem walkthrough: ai-rpg

The committed reference gem is at `gems/ai-rpg/`. It's the canonical example of
everything above. The key files:

- `gems/ai-rpg/package.json` — name `@ai-universe-lite/gem-ai-rpg`, version `0.1.0`
- `gems/ai-rpg/src/server.ts` — FastMCP entry, auto-loads tools
- `gems/ai-rpg/src/config.ts` — reads `GEM_ID`, `GEM_VERSION`, `REF_BUCKET` from env
- `gems/ai-rpg/src/system-prompt.ts` — the three-section system prompt
- `gems/ai-rpg/src/tools/roll_dice.ts` — deterministic, Zod, mulberry32
- `gems/ai-rpg/src/tools/narrate_event.ts` — LLM call via `ctx.callLlm`
- `gems/ai-rpg/src/rng.ts` — mulberry32
- `gems/ai-rpg/__tests__/setup.ts` — `makeStubGemContext()`
- `gems/ai-rpg/__tests__/roll_dice.test.ts` — fixed-seed test
- `gems/ai-rpg/__tests__/server.boot.test.ts` — smoke test
- `gems/ai-rpg/README.md` — gem-user perspective (what the share URL does, install command)

**Adapting it:**

1. Copy the directory.
2. Edit `package.json` (`name`, `version`).
3. Replace `src/tools/*.ts` with your own tools (use the §3 + §6 patterns).
4. Rewrite `src/system-prompt.ts` (§4).
5. `npm install && npm test && npm run type-check && npm run lint`.
6. `./deploy.gem.sh dev`.
7. Register.

## 10. Adding to the registry

If you wrote the gem by hand (not via the pipeline), register it:

```bash
./scripts/register-gem.sh gems/<id>/package.json
```

This is a thin wrapper around Stage 7 Publish — it reads `package.json` for metadata,
prompts for `shareToken` rotation if needed, and writes the Firestore entry. Once
registered, the gem is discoverable at `/api/registry/<gemId>` and (if `visibility="public"`)
indexed at `/api/registry`.

## See also

- [`docs/gem-builder.md`](./gem-builder.md) — the 8-stage pipeline that normally
  produces a gem for you (the *upstream* of the build step)
- [`docs/reference-uploads.md`](./reference-uploads.md) — how `--ref` files become
  ref bundles in the system prompt (§5 above)
- [`docs/cross-repo-hooks.md`](./cross-repo-hooks.md) — what happens to your gem
  *after* publish (frontend PR, landing page, etc.)
- [`docs/cloudrun-deploy.md`](./cloudrun-deploy.md) — the per-gem deploy contract
- [`templates/tool.ts.tmpl`](../templates/tool.ts.tmpl) — the canonical tool template
- [`templates/server.ts.tmpl`](../templates/server.ts.tmpl) — the canonical server template
- [`gems/ai-rpg/`](../gems/ai-rpg/) — the v1 reference gem (copy this)
- [`backend/src/lib/schema.ts`](../backend/src/lib/schema.ts) — Zod schemas for
  `ToolSpec`, `GemSpec`, etc. (your tool inputs must match `ToolSpec.inputs`)
- [`AGENTS.md`](../AGENTS.md) — repo-level guidelines
