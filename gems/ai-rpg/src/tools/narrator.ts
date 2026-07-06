// narrator.ts — produces a short narrative beat for the player's last action.
//
// In production (when `ctx.callLlm` is wired to a real model) the tool composes:
//
//     ctx.systemPrompt  +  "\n\n"  +  <intake ref text>  +  "\n\n"  +  lastAction
//
// and asks the LLM to return a 2-3 sentence narration in the GM voice. When
// `ctx.callLlm` is the runtime stub (returns ""), we fall back to a
// deterministic offline response so unit tests can run without keys.

import { z } from "zod";
import type { ToolFactory } from "@ai-universe/gem-runtime";
import { loadIntakeRefs } from "../references.js";

const InputSchema = z.object({
  intakeId: z.string().min(1),
  lastAction: z.string().min(1),
  worldStateContext: z.string().optional(),
});

const NARRATOR_MODEL = "claude-3-5-haiku-20241022";

function jsonContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const narratorTool: ToolFactory = (ctx) => ({
  name: "narrator",
  description:
    "Produces a short narrative beat for the player's last action. When an LLM is configured, it conditions on the gem's system prompt, the intake's reference files, and the current world-state context. When no LLM is wired up, returns a deterministic stub: \"You consider: <lastAction>\".",
  parameters: InputSchema,
  execute: async (params: z.infer<typeof InputSchema>) => {
    const { intakeId, lastAction, worldStateContext } = params;
    const refs = await loadIntakeRefs(ctx, intakeId);
    const refBlock = Object.entries(refs)
      .map(([name, body]) => `### ${name}\n${body}`)
      .join("\n\n");

    const worldBlock = worldStateContext ? `\n\n## World State\n${worldStateContext}` : "";
    const composed = `${ctx.systemPrompt}\n\n## Intake References\n${refBlock}${worldBlock}\n\n## Last Action\n${lastAction}\n\nRespond with a 2-4 sentence narration in second-person present tense. Stay in character; honor any rules in the reference block.`;

    const text = await ctx.callLlm(NARRATOR_MODEL, composed);
    if (text && text.trim().length > 0) {
      return jsonContent(text.trim());
    }

    // Test-mode / no-LLM fallback — fully deterministic.
    return jsonContent(`You consider: ${lastAction}`);
  },
});

export default narratorTool;
