// Placeholder — Phase 1 implements loadGemContext + ctx.refs
import type { FastMCP } from "fastmcp";
export type GemContext = {
  gemId: string;
  gemVersion: string;
  systemPrompt: string;
  refs: Map<string, { gcsPath: string; mimeType: string; sizeBytes: number }>;
  callLlm: (model: string, prompt: string) => Promise<string>;
  readTextRef: (filename: string) => Promise<string>;
};
export const GEM_RUNTIME_VERSION = "0.1.0";
export function loadGemContext(_opts: {
  gemId: string;
  gemVersion: string;
  systemPrompt: string;
  bundleRefs?: boolean;
}): GemContext {
  return {
    gemId: _opts.gemId,
    gemVersion: _opts.gemVersion,
    systemPrompt: _opts.systemPrompt,
    refs: new Map(),
    callLlm: async () => "",
    readTextRef: async () => "",
  };
}
export type ToolFactory = (ctx: GemContext) => Parameters<FastMCP["addTool"]>[0];
