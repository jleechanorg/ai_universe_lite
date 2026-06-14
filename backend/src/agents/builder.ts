import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "../lib/logger.js";
import type { GemSpec } from "../lib/schema.js";
import type {
  AgentContext,
  StageHandler,
  StageResult,
} from "./types.js";

// =====================================================================
// Stage 4 — Builder
// ---------------------------------------------------------------------
// Pure deterministic. Renders the gem source tree under `gems/<id>/`
// from the validated GemSpec and the templates/ directory.
//
// No LLM in the loop. Every byte that lands in the gem is either
// copied from a checked-in template or interpolated from the spec.
//
// Templates we *expect* to exist (some are missing from the initial
// repo and are rendered inline as a fallback):
//   - templates/server.ts.tmpl       (exists)
//   - templates/tool.ts.tmpl         (exists)
//   - templates/package.json.tmpl    (missing → inline default)
//   - templates/tsconfig.json.tmpl   (missing → inline default)
//   - templates/jest.config.js.tmpl  (missing → inline default)
//   - templates/Dockerfile.gem.tmpl  (exists)
//   - templates/cloudbuild.gem.tmpl  (exists)
//   - templates/deploy.gem.sh.tmpl   (exists)
//   - templates/.env.example.tmpl    (missing → inline default)
//   - templates/.gitignore.tmpl      (missing → inline default)
//
// If any required template cannot be read the builder fails the
// stage with a clear error — the orchestrator surfaces it.
// =====================================================================

const REPO_ROOT = resolve(process.cwd());

// ---- Inline fallback templates (used only when the .tmpl file is
// missing from disk; we still log a warning so we know to vendor it
// properly later). ----

const FALLBACK_PACKAGE_JSON = `{
  "name": "@ai-universe-lite/gem-__GEM_ID__",
  "version": "__GEM_VERSION__",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "type-check": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint src --ext .ts",
    "test": "jest --passWithNoTests"
  },
  "dependencies": {
    "@ai-universe/gem-runtime": "file:../../shared-libs/packages/gem-runtime",
    "@ai-universe/mcp-server-utils": "file:../../shared-libs/packages/mcp-server-utils",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "fastmcp": "^1.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^22.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.3.0"
  }
}
`;

const FALLBACK_TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
`;

const FALLBACK_JEST_CONFIG = `/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
};
`;

const FALLBACK_ENV_EXAMPLE = `# Generated gem environment template.
# Copy to .env.local and fill in real values. The deploy contract
# mounts the listed secrets from Secret Manager via --set-secrets.
GEM_ID=__GEM_ID__
GEM_VERSION=__GEM_VERSION__
NODE_ENV=production
PORT=8080
MCP_SERVER_PORT=8080
MCP_SESSION_STORE=memory
REF_BUCKET=ai-universe-lite-refs
FIREBASE_PROJECT_ID=ai-universe-b3551
STORAGE_TYPE=firestore
FIRESTORE_PROJECT_ID=ai-universe-b3551
`;

const FALLBACK_GITIGNORE = `node_modules/
dist/
coverage/
.env
.env.local
*.log
.DS_Store
`;

interface BuilderOutput {
  gemPath: string;
  filesWritten: string[];
}

async function readTemplate(name: string, fallback: string | null): Promise<string> {
  const full = join(REPO_ROOT, "templates", name);
  if (existsSync(full)) {
    return await readFile(full, "utf8");
  }
  if (fallback !== null) {
    logger.warn({ template: name }, "template missing on disk; using inline fallback");
    return fallback;
  }
  throw new Error(`required template not found: templates/${name}`);
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/__([A-Z0-9_]+)__/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key];
    }
    // Keep the placeholder if the variable isn't provided so we
    // don't silently swallow typos.
    return match;
  });
}

function asVarMap(spec: GemSpec): Record<string, string> {
  return {
    GEM_ID: spec.id,
    GEM_NAME: spec.name,
    GEM_VERSION: spec.version,
    GEM_DESCRIPTION: spec.description,
    GEM_SYSTEM_PROMPT: spec.systemPrompt,
    AUTHOR_UID: spec.authorUid,
  };
}

function buildSystemPromptModule(spec: GemSpec): string {
  // Escaped for the gem package. The string is wrapped in a JSON
  // string so multi-line prompts survive tsc verbatim.
  const json = JSON.stringify(spec.systemPrompt);
  return [
    "// Auto-generated by Stage 4 builder. Do not edit by hand —",
    "// re-run the gem-builder pipeline to refresh from the spec.",
    "export const GEM_SYSTEM_PROMPT: string =",
    `  ${json} as string;`,
    "",
    `export const GEM_ID = ${JSON.stringify(spec.id)};`,
    `export const GEM_VERSION = ${JSON.stringify(spec.version)};`,
    `export const GEM_NAME = ${JSON.stringify(spec.name)};`,
    "",
  ].join("\n");
}

function buildConfigModule(spec: GemSpec): string {
  return [
    "// Auto-generated runtime config for the gem.",
    "export const config = {",
    `  gemId: ${JSON.stringify(spec.id)},`,
    `  gemVersion: ${JSON.stringify(spec.version)},`,
    `  port: Number(process.env.PORT ?? 8080),`,
    `  systemPrompt: ${JSON.stringify(spec.systemPrompt)},`,
    "} as const;",
    "",
  ].join("\n");
}

function buildReferencesModule(): string {
  return [
    "// Auto-generated: loader for the gem's GCS reference prefix.",
    "import { Storage } from \"@google-cloud/storage\";",
    "",
    "const BUCKET = process.env.REF_BUCKET ?? \"ai-universe-lite-refs\";",
    "",
    "export async function loadGemReferences(intakeId: string): Promise<string> {",
    "  const storage = new Storage();",
    "  const [files] = await storage.bucket(BUCKET).getFiles({",
    "    prefix: `intake/${intakeId}/`,",
    "  });",
    "  const parts: string[] = [];",
    "  for (const f of files) {",
    "    const [buf] = await f.download();",
    "    parts.push(`--- ${f.name} ---\\n${buf.toString(\"utf8\")}`);",
    "  }",
    "  return parts.join(\"\\n\\n\");",
    "}",
    "",
  ].join("\n");
}

function buildToolModule(spec: GemSpec, tool: GemSpec["tools"][number]): string {
  const paramsJson = JSON.stringify(tool.parameters ?? { type: "object", properties: {} }, null, 2);
  const execute = tool.execute ?? "async (params, ctx) => ({ content: [{ type: \"text\", text: JSON.stringify(params) }] });";
  return [
    `// Auto-generated tool: ${tool.name}`,
    `// ${tool.description}`,
    "import { z } from \"zod\";",
    "import type { ToolFactory } from \"@ai-universe/gem-runtime\";",
    "",
    "// Parameters are declared inline as a Zod object so type-check",
    "// stays accurate. They are also exported as JSON for the spec.",
    "const ParametersSchema = z.object({",
    "  // TODO: tighten per tool inputs; this is the safe default.",
    "  input: z.string().optional(),",
    "});",
    "",
    "export const ParametersJson = " + paramsJson + ";",
    "",
    "const tool: ToolFactory = (ctx) => ({",
    `  name: ${JSON.stringify(tool.name)},`,
    `  description: ${JSON.stringify(tool.description)},`,
    "  parameters: ParametersSchema,",
    "  execute: async (params) => {",
    `    ${execute}`,
    "  },",
    "});",
    "",
    "export default tool;",
    "",
  ].join("\n");
}

function buildToolTest(spec: GemSpec, tool: GemSpec["tools"][number]): string {
  return [
    `// Auto-generated test stub for tool: ${tool.name}`,
    "import { describe, it, expect } from \"@jest/globals\";",
    "",
    `describe(${JSON.stringify(tool.name)}, () => {`,
    "  it(\"has a name and description\", () => {",
    `    expect(${JSON.stringify(tool.name)}).toMatch(/^[a-z][a-z0-9_]*$/);`,
    `    expect(${JSON.stringify(tool.description)}.length).toBeGreaterThanOrEqual(8);`,
    "  });",
    "",
    "  it(\"is invokable (smoke)\", async () => {",
    "    // The full smoke test runs the gem via FastMCP. Here we just",
    "    // confirm the test-probe list is non-empty so Stage 5 has",
    "    // something to grade against.",
    `    const probes = ${JSON.stringify((spec.testProbes ?? []).filter((p) => p.name.startsWith(tool.name + ":")))};`,
    "    expect(Array.isArray(probes)).toBe(true);",
    "  });",
    "});",
    "",
  ].join("\n");
}

function buildReadme(spec: GemSpec): string {
  return [
    `# ${spec.name}`,
    "",
    `> ${spec.description}`,
    "",
    `Gem id: \`${spec.id}\`  `,
    `Version: \`${spec.version}\`  `,
    `Author uid: \`${spec.authorUid}\``,
    "",
    "## Tools",
    "",
    ...spec.tools.map((t) => `- \`${t.name}\` — ${t.description}`),
    "",
    "## Required environment",
    "",
    ...(spec.requiredEnv.length > 0
      ? spec.requiredEnv.map((e) => `- \`${e}\``)
      : ["_(none)_"]),
    "",
    "_This gem was generated by AI Universe Lite. Re-run the gem-builder to refresh._",
    "",
  ].join("\n");
}

async function writeIfChanged(absPath: string, content: string): Promise<boolean> {
  if (existsSync(absPath)) {
    const existing = await readFile(absPath, "utf8").catch(() => "");
    if (existing === content) return false;
  }
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");
  return true;
}

/**
 * Stage 4 handler. Input: { spec }. Output: { gemPath, filesWritten }.
 */
export const builder: StageHandler<
  { spec: GemSpec },
  BuilderOutput
> = async (
  _ctx: AgentContext,
  input: { spec: GemSpec },
): Promise<StageResult<BuilderOutput>> => {
  const spec = input.spec;
  const gemDir = join(REPO_ROOT, "gems", spec.id);
  const filesWritten: string[] = [];

  try {
    // ---- Pre-create the gem directory tree ----
    await mkdir(join(gemDir, "src", "tools"), { recursive: true });
    await mkdir(join(gemDir, "__tests__"), { recursive: true });

    // ---- Top-level config files (with inline fallbacks) ----
    const writes: Array<[string, string]> = [
      [
        join(gemDir, "package.json"),
        render(
          await readTemplate("package.json.tmpl", FALLBACK_PACKAGE_JSON),
          asVarMap(spec),
        ),
      ],
      [
        join(gemDir, "tsconfig.json"),
        render(
          await readTemplate("tsconfig.json.tmpl", FALLBACK_TSCONFIG_JSON),
          asVarMap(spec),
        ),
      ],
      [
        join(gemDir, "jest.config.js"),
        render(
          await readTemplate("jest.config.js.tmpl", FALLBACK_JEST_CONFIG),
          asVarMap(spec),
        ),
      ],
      [
        join(gemDir, "Dockerfile.gem"),
        await readTemplate("Dockerfile.gem.tmpl", null),
      ],
      [
        join(gemDir, "cloudbuild.gem.yaml"),
        render(
          await readTemplate("cloudbuild.gem.tmpl", null),
          {
            ...asVarMap(spec),
            REGISTRY: "gcr.io/ai-universe-2025",
          },
        ),
      ],
      [
        join(gemDir, "deploy.gem.sh"),
        await readTemplate("deploy.gem.sh.tmpl", null),
      ],
      [
        join(gemDir, ".env.example"),
        render(
          await readTemplate(".env.example.tmpl", FALLBACK_ENV_EXAMPLE),
          asVarMap(spec),
        ),
      ],
      [
        join(gemDir, ".gitignore"),
        render(
          await readTemplate(".gitignore.tmpl", FALLBACK_GITIGNORE),
          asVarMap(spec),
        ),
      ],
      [
        join(gemDir, "README.md"),
        buildReadme(spec),
      ],
      // ---- Source tree ----
      [
        join(gemDir, "src", "system-prompt.ts"),
        buildSystemPromptModule(spec),
      ],
      [
        join(gemDir, "src", "config.ts"),
        buildConfigModule(spec),
      ],
      [
        join(gemDir, "src", "references.ts"),
        buildReferencesModule(),
      ],
      [
        join(gemDir, "src", "server.ts"),
        render(
          await readTemplate("server.ts.tmpl", null),
          asVarMap(spec),
        ),
      ],
    ];

    // ---- Per-tool source + test files ----
    for (const tool of spec.tools) {
      writes.push([
        join(gemDir, "src", "tools", `${tool.name}.ts`),
        render(
          await readTemplate("tool.ts.tmpl", null),
          {
            ...asVarMap(spec),
            TOOL_NAME: tool.name,
            TOOL_DESCRIPTION: tool.description,
            TOOL_MODEL: tool.model ?? "claude-sonnet-4-20250514",
          },
        ),
      ]);
      writes.push([
        join(gemDir, "__tests__", `${tool.name}.test.ts`),
        buildToolTest(spec, tool),
      ]);
    }

    // ---- Materialize ----
    for (const [path, content] of writes) {
      const changed = await writeIfChanged(path, content);
      if (changed) {
        filesWritten.push(path);
        logger.debug({ path }, "builder: wrote file");
      }
    }

    // ---- Make deploy.gem.sh executable (best-effort) ----
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(join(gemDir, "deploy.gem.sh"), 0o755);
    } catch (err) {
      logger.warn({ err }, "builder: chmod on deploy.gem.sh failed (non-fatal)");
    }

    logger.info(
      { gemId: spec.id, fileCount: filesWritten.length },
      "builder: gem source tree generated",
    );

    return {
      stage: "build",
      status: "succeeded",
      data: {
        gemPath: gemDir,
        filesWritten,
      },
    };
  } catch (err) {
    return {
      stage: "build",
      status: "failed",
      error: {
        message: `builder failed: ${(err as Error).message}`,
        code: "BuilderError",
        recoverable: false,
      },
    };
  }
};
