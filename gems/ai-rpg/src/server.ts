// server.ts — FastMCP entrypoint for the ai-rpg gem.
//
// Boot order:
//   1. Read runtime config (env-driven).
//   2. Load the gem context (gemId / gemVersion / systemPrompt / refs / callLlm / readTextRef).
//   3. Auto-discover every `src/tools/*.ts` module via `import.meta.glob({ eager: true })`.
//   4. Each tool module exports a `ToolFactory` as its default export; invoke it with the
//      gem context and hand the resulting FastMCP tool def to `server.addTool(...)`.
//   5. Start the FastMCP server on `httpStream` at `config.port` (Cloud Run default 8080).

import { FastMCP } from "fastmcp";
import { loadGemContext, type GemContext } from "@ai-universe/gem-runtime";
import { config } from "./config.js";
import { GEM_SYSTEM_PROMPT } from "./system-prompt.js";

// FastMCP's `FastMCPSessionAuth` type is not re-exported from the package,
// so derive the tool-parameter shape locally via `Parameters<...>`. The
// `undefined` generic matches the default session-auth type used by FastMCP.
type Tool = Parameters<FastMCP<undefined>["addTool"]>[0];

const ctx = loadGemContext({
  gemId: config.gemId,
  gemVersion: config.gemVersion,
  systemPrompt: GEM_SYSTEM_PROMPT,
  bundleRefs: true,
});

// FastMCP's ServerOptions.version is a strict `${number}.${number}.${number}` literal,
// but our gemVersion comes from package.json and may carry a pre-release tag, so we
// cast through unknown to keep the runtime permissive without dropping the constraint.
const fastMcpVersion = ctx.gemVersion as unknown as `${number}.${number}.${number}`;

const server = new FastMCP({ name: ctx.gemId, version: fastMcpVersion });

// Auto-discover tool factories under src/tools/*.ts.
// `import.meta.glob` is a Vite-style helper that resolves to an object of
// { "<path>": <module> }; combined with `{ eager: true }` it is the canonical
// pattern for runtime tool registration in the gem-builder pipeline.
type ToolModule = { default?: (c: GemContext) => Tool };
// `import.meta.glob` is provided by Vite at build time; the type isn't in
// standard lib so we widen the type locally to keep tsc happy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolModules: Record<string, ToolModule> = (import.meta as any).glob
  ? (import.meta as any).glob("./tools/*.ts", { eager: true })
  : {};

for (const mod of Object.values(toolModules)) {
  if (typeof mod.default === "function") {
    const tool = mod.default(ctx);
    // FastMCP's addTool is a runtime method, not a strongly-typed one; cast keeps
    // this aligned with the rest of the gem-runtime convention.
    server.addTool(tool);
  }
}

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : config.port;
server.start({ transportType: "httpStream", httpStream: { endpoint: "/mcp", port } });
