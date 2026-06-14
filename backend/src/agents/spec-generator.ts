import { z } from "zod";
import {
  BrainstormOutputSchema,
  GemSpecSchema,
  type BrainstormOutput,
  type GemSpec,
} from "../lib/schema.js";
import {
  DEFAULT_CLAUDE_MODEL,
  LlmError,
} from "./llm-client.js";
import type {
  AgentContext,
  StageHandler,
  StageResult,
} from "./types.js";

// =====================================================================
// Stage 3 — Spec Generator
// ---------------------------------------------------------------------
// Takes the validated BrainstormOutput and asks Claude to produce a
// GemSpec — the canonical description of the gem: id, name, tools
// (each with a Zod parameters schema as JSON and a TypeScript
// `execute` function body as a string), systemPrompt, dependencies,
// and testProbes.
//
// Tools the spec describes are eventually rendered into
// `gems/<id>/src/tools/<name>.ts` by Stage 4. We keep the `execute`
// body as a string of TypeScript source so the spec is portable and
// diff-friendly (no need to serialize closures).
//
// On Zod validation failure: retry once with the validation errors
// injected; on second failure, mark the stage `failed`.
// =====================================================================

function buildSystemPrompt(): string {
  return [
    "You are the Stage 3 spec-generator of the AI Universe Lite gem-builder pipeline.",
    "Your only job is to turn a validated BrainstormOutput into a machine-validated",
    "GemSpec JSON. Do NOT write the final source code — only describe it.",
    "",
    "## Output contract",
    "",
    "Respond with a single JSON object matching the GemSpec Zod schema:",
    "",
    "{",
    '  "id": "<kebab-case-id>",', // e.g. ai-rpg
    '  "name": "<Human Name>",',
    '  "version": "0.1.0",',
    '  "description": "<one-line tagline, 20..280 chars>",',
    '  "systemPrompt": "<the gem system prompt, 80..8000 chars>",',
    '  "tools": [',
    "    {",
    '      "name": "snake_case_tool_name",',
    '      "description": "what the tool does (>= 8 chars)",',
    '      "parameters": { "type": "object", "properties": { ... }, "required": [...] },',
    '      "execute": "async (params, ctx) => { /* typescript body */ return { content: [{ type: "text", text: ... }] }"',
    "    }",
    "  ],",
    '  "dependencies": ["@ai-universe/gem-runtime", "zod"],',
    '  "testProbes": [{ "name": "...", "input": { ... }, "expected": "..." }],',
    '  "requiredEnv": ["ANTHROPIC_API_KEY"]',
    "}",
    "",
    "Constraints:",
    "- `id` MUST match /^[a-z][a-z0-9-]{1,40}$/ (kebab-case, 2..41 chars).",
    "- `version` MUST be a semver string like \"0.1.0\".",
    "- `systemPrompt` MUST be 80..8000 chars. It will be the gem's MCP system prompt.",
    "- `tools[].parameters` MUST be a valid JSON Schema (Zod-compatible).",
    "- `tools[].execute` MUST be a TypeScript string of an async function body. Do not",
    "  include the function signature — just the body that returns a FastMCP-shaped",
    "  `{ content: [{ type: \"text\", text: string }] }`.",
    "- `dependencies` is a list of npm package names the gem will need at runtime.",
    "- `testProbes` is a non-empty list of probes the Stage 5 verifier and Stage 6",
    "  evaluator will use. Each probe has `name`, `input` (object matching the tool's",
    "  parameters schema), and `expected` (a string describing the expected output).",
    "- `requiredEnv` lists the names of environment variables / Secret Manager keys the",
    "  gem needs (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY). Only include keys that",
    "  BrainstormOutput.modelNeeds implies.",
    "- BrainstormOutput is included verbatim in the spec under the `brainstorm` key.",
    "",
    "Respond with the JSON object only. No prose, no markdown fences.",
  ].join("\n");
}

function buildUserMessage(brainstorm: BrainstormOutput): string {
  return [
    "# BrainstormOutput",
    "",
    "```json",
    JSON.stringify(brainstorm, null, 2),
    "```",
    "",
    "Now produce the GemSpec. Respond with the JSON object only.",
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError;
}

function recoverFromParseError(rawText: string, zodError: z.ZodError): string {
  return [
    "Your previous response failed JSON / Zod validation. Here is the raw text",
    "you returned (use it as a hint — regenerate from scratch, do not patch):",
    "",
    "```",
    rawText.slice(0, 6000),
    "```",
    "",
    "Validation errors:",
    "",
    "```json",
    JSON.stringify(zodError.issues, null, 2),
    "```",
    "",
    "Respond with a single GemSpec JSON object only. No prose, no fences.",
  ].join("\n");
}

/**
 * Stage 3 handler. Input: { brainstorm }. Output: GemSpec.
 *
 * The returned GemSpec embeds the input BrainstormOutput under
 * `brainstorm` so downstream stages (build, evaluate) can read both
 * without re-fetching pipeline state.
 */
export const specGenerator: StageHandler<
  { brainstorm: BrainstormOutput },
  GemSpec
> = async (
  ctx: AgentContext,
  input: { brainstorm: BrainstormOutput },
): Promise<StageResult<GemSpec>> => {
  // Defensive: re-validate the brainstorm before feeding it. If the
  // orchestrator hands us a malformed brainstorm we fail fast.
  try {
    BrainstormOutputSchema.parse(input.brainstorm);
  } catch (err) {
    return {
      stage: "spec",
      status: "failed",
      error: {
        message: `brainstorm input did not match Zod schema: ${String(
          (err as Error).message,
        )}`,
        code: "InvalidBrainstorm",
        recoverable: false,
      },
    };
  }

  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(input.brainstorm);

  // ---- First attempt ----
  let raw: string;
  try {
    raw = await ctx.llm.callClaude(
      DEFAULT_CLAUDE_MODEL,
      systemPrompt,
      userMessage,
    );
  } catch (err) {
    const message = isLlmError(err)
      ? `spec LLM call failed (${err.errorClass}): ${err.message}`
      : `spec LLM call failed: ${String(err)}`;
    return {
      stage: "spec",
      status: "failed",
      error: {
        message,
        code: isLlmError(err) ? err.errorClass : "LlmCallFailed",
        recoverable: isLlmError(err) ? err.recoverable : false,
      },
    };
  }

  // ---- Validate (Zod) ----
  const jsonText = extractJson(raw);
  let parsed: GemSpec;
  try {
    parsed = GemSpecSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    if (!(err instanceof z.ZodError) && !(err instanceof SyntaxError)) {
      return {
        stage: "spec",
        status: "failed",
        error: {
          message: `unexpected parse error: ${String(err)}`,
          code: "ParseError",
          recoverable: false,
        },
      };
    }
    // ---- Retry once with validation errors injected ----
    const issueList = err instanceof z.ZodError
      ? err.issues
      : [{ message: (err as Error).message, path: [] }];
    const retryUser = recoverFromParseError(raw, {
      issues: issueList,
    } as z.ZodError);
    let retryRaw: string;
    try {
      retryRaw = await ctx.llm.callClaude(
        DEFAULT_CLAUDE_MODEL,
        systemPrompt,
        retryUser,
      );
    } catch (llmErr) {
      const message = isLlmError(llmErr)
        ? `spec retry LLM call failed (${llmErr.errorClass}): ${llmErr.message}`
        : `spec retry LLM call failed: ${String(llmErr)}`;
      return {
        stage: "spec",
        status: "failed",
        error: {
          message,
          code: isLlmError(llmErr) ? llmErr.errorClass : "LlmCallFailed",
          recoverable: isLlmError(llmErr) ? llmErr.recoverable : false,
        },
      };
    }
    const retryJson = extractJson(retryRaw);
    try {
      parsed = GemSpecSchema.parse(JSON.parse(retryJson));
    } catch (err2) {
      const issues = err2 instanceof z.ZodError
        ? err2.issues
        : [{ message: (err2 as Error).message }];
      return {
        stage: "spec",
        status: "failed",
        error: {
          message: `spec output did not match Zod schema after retry: ${JSON.stringify(issues)}`,
          code: "ZodValidationFailed",
          recoverable: false,
        },
      };
    }
  }

  return { stage: "spec", status: "succeeded", data: parsed };
};
