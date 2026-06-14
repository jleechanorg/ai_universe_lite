import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BrainstormOutputSchema,
  type BrainstormOutput,
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
// Stage 2 — Brainstormer
// ---------------------------------------------------------------------
// Activates the vendored `superpowers-brainstorming` skill and asks
// Claude to produce a BrainstormOutput (featureSet, tools, modelNeeds,
// reasoning) from the user's prompt + any uploaded reference docs.
//
// On Zod validation failure we retry ONCE with the validation errors
// injected into the user message. A second failure returns
// `status: "failed"` — the orchestrator surfaces the error to the
// /api/gems/<runId> polling endpoint and stops the pipeline.
// =====================================================================

const BRAINSTORM_SKILL_PATH = ".claude/skills/superpowers-brainstorming/SKILL.md";

let cachedSkillBody: string | null = null;

async function loadSkillBody(repoRoot: string): Promise<string> {
  if (cachedSkillBody !== null) return cachedSkillBody;
  const fullPath = join(repoRoot, BRAINSTORM_SKILL_PATH);
  const body = await readFile(fullPath, "utf8").catch(() => "");
  // Strip the YAML frontmatter so the prompt is pure markdown.
  const stripped = body.replace(/^---[\s\S]*?---\s*/m, "");
  cachedSkillBody = stripped.trim();
  return cachedSkillBody;
}

function buildSystemPrompt(skillBody: string): string {
  return [
    "You are the Stage 2 brainstormer of the AI Universe Lite gem-builder pipeline.",
    "Your only job is to turn a user prompt + optional reference documents into a",
    "machine-validated `BrainstormOutput` JSON. Do NOT write code, do NOT apologize,",
    "do NOT add commentary outside the JSON.",
    "",
    "## Activated skill: superpowers-brainstorming",
    "",
    skillBody,
    "",
    "## Output contract",
    "",
    "Respond with a single JSON object matching the BrainstormOutput Zod schema:",
    "{",
    '  "featureSet": string[>=1],',
    '  "tools": [{ "name": string, "purpose": string, "inputs": string[], "outputs": string[] }],',
    '  "modelNeeds": ("openai"|"anthropic"|"gemini"|"perplexity"|"openrouter"|"grok")[],',
    '  "reasoning": string',
    "}",
    "",
    "Constraints:",
    "- `featureSet` MUST be non-empty (>= 1 feature).",
    "- `tools` MUST be 1..N. Each tool's `name` MUST be snake_case.",
    "- `reasoning` MUST be 80..2000 chars of markdown explaining your design choices.",
    "- Do not invent tools that need credentials not listed in `modelNeeds`.",
    "- If the prompt is ambiguous, pick a reasonable interpretation and note it in `reasoning`.",
  ].join("\n");
}

function buildUserMessage(input: { prompt: string; refs: string }): string {
  const sections: string[] = [];
  sections.push("# User prompt");
  sections.push("");
  sections.push(input.prompt);
  if (input.refs.trim().length > 0) {
    sections.push("");
    sections.push("# Reference documents (extracted text)");
    sections.push("");
    sections.push(input.refs);
  }
  sections.push("");
  sections.push("Now respond with the BrainstormOutput JSON only.");
  return sections.join("\n");
}

function extractJson(text: string): string {
  // Strip markdown ```json fences (the model occasionally wraps the
  // response even when told not to).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  // Otherwise take the first {...} block.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError;
}

function recoverFromParseError(
  rawText: string,
  zodError: z.ZodError,
): string {
  return [
    "Your previous response failed JSON / Zod validation. Here is the raw text",
    "you returned (use it as a hint — regenerate from scratch, do not patch):",
    "",
    "```",
    rawText.slice(0, 4000),
    "```",
    "",
    "Validation errors:",
    "",
    "```json",
    JSON.stringify(zodError.issues, null, 2),
    "```",
    "",
    "Respond with a single BrainstormOutput JSON object only. No prose, no fences.",
  ].join("\n");
}

/**
 * Stage 2 handler. Input: { prompt, refs }. Output: BrainstormOutput.
 *
 * The `refs` string is the concatenated text of any uploaded
 * reference docs (Stage 1 joins them and stores them in pipeline
 * state). The handler never talks to GCS directly.
 */
export const brainstormer: StageHandler<
  { prompt: string; refs: string },
  BrainstormOutput
> = async (
  ctx: AgentContext,
  input: { prompt: string; refs: string },
): Promise<StageResult<BrainstormOutput>> => {
  const skillBody = await loadSkillBody(process.cwd());
  const systemPrompt = buildSystemPrompt(skillBody);
  const userMessage = buildUserMessage(input);

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
      ? `brainstorm LLM call failed (${err.errorClass}): ${err.message}`
      : `brainstorm LLM call failed: ${String(err)}`;
    return {
      stage: "brainstorm",
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
  let parsed: BrainstormOutput;
  try {
    parsed = BrainstormOutputSchema.parse(JSON.parse(jsonText));
  } catch (err) {
    if (!(err instanceof z.ZodError) && !(err instanceof SyntaxError)) {
      return {
        stage: "brainstorm",
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
        ? `brainstorm retry LLM call failed (${llmErr.errorClass}): ${llmErr.message}`
        : `brainstorm retry LLM call failed: ${String(llmErr)}`;
      return {
        stage: "brainstorm",
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
      parsed = BrainstormOutputSchema.parse(JSON.parse(retryJson));
    } catch (err2) {
      const issues = err2 instanceof z.ZodError
        ? err2.issues
        : [{ message: (err2 as Error).message }];
      return {
        stage: "brainstorm",
        status: "failed",
        error: {
          message: `brainstorm output did not match Zod schema after retry: ${JSON.stringify(issues)}`,
          code: "ZodValidationFailed",
          recoverable: false,
        },
      };
    }
  }

  return { stage: "brainstorm", status: "succeeded", data: parsed };
};
