/**
 * setup.ts — Jest setup file for the ai-rpg gem.
 *
 * Runs before every test file (per `jest.config.js#setupFiles`).
 * - Forces a stable environment (NODE_ENV=test) so deterministic fallbacks apply.
 * - Silences the logger by setting LOG_LEVEL=silent (consumed by mcp-server-utils
 *   or any pino-style logger that reads process.env directly).
 * - Exposes shared fixtures and a stub GemContext factory for tool tests.
 */

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MCP_SESSION_STORE = process.env.MCP_SESSION_STORE ?? "memory";

// Disable noisy deprecation warnings from node:test that some test deps pull in.
process.env.NODE_NO_WARNINGS = "1";

import type { GemContext } from "@ai-universe/gem-runtime";

/**
 * Build a deterministic, LLM-free GemContext for unit tests.
 *
 * `callLlm` returns the empty string by default, which signals to every tool
 * (character_sheet, narrator) to fall back to deterministic output. Override
 * via the `callLlm` parameter to exercise the LLM codepath.
 *
 * `readTextRef` returns "" unless an explicit `refs` map is provided.
 */
export function makeStubGemContext(overrides: {
  refs?: Map<string, { gcsPath: string; mimeType: string; sizeBytes: number }>;
  callLlm?: (model: string, prompt: string) => Promise<string>;
  readTextRef?: (filename: string) => Promise<string>;
  systemPrompt?: string;
} = {}): GemContext {
  const refs =
    overrides.refs ??
    new Map<string, { gcsPath: string; mimeType: string; sizeBytes: number }>();
  return {
    gemId: "ai-rpg",
    gemVersion: "0.1.0-test",
    systemPrompt: overrides.systemPrompt ?? "Test system prompt.",
    refs,
    callLlm: overrides.callLlm ?? (async () => ""),
    readTextRef: overrides.readTextRef ?? (async () => ""),
  };
}

/** Parse the `text` field out of a FastMCP tool response. */
export function parseToolJson(response: { content: Array<{ type: string; text: string }> }): unknown {
  const text = response.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`Tool response missing text content: ${JSON.stringify(response)}`);
  }
  return JSON.parse(text);
}

/** Standard D&D 5e stat block used in character_sheet tests. */
export const SAMPLE_STATS = {
  str: 16,
  dex: 14,
  con: 13,
  int: 12,
  wis: 15,
  cha: 10,
} as const;

/** Expected mod array for SAMPLE_STATS: [+3, +2, +1, +1, +2, +0]. */
export const SAMPLE_MODS = {
  str: 3,
  dex: 2,
  con: 1,
  int: 1,
  wis: 2,
  cha: 0,
} as const;
