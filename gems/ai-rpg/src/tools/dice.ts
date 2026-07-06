// dice.ts — deterministic dice rolling with a seedable PRNG.
//
// All randomness flows through `mulberry32`, a small but high-quality 32-bit
// PRNG. Pass `seed` to get reproducible output (useful for tests and for
// the narrator tool to keep a session deterministic); omit it to fall back
// to `Math.random` per roll.

import { z } from "zod";
import type { ToolFactory } from "@ai-universe/gem-runtime";

const InputSchema = z.object({
  action: z.enum(["roll_dice", "roll_stat", "roll_d100"]),
  notation: z.string().optional(),
  seed: z.number().int().nonnegative().optional(),
});

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number | undefined): Rng {
  if (typeof seed === "number") {
    return mulberry32(seed);
  }
  return Math.random;
}

function rollDie(rng: Rng, sides: number): number {
  return Math.floor(rng() * sides) + 1;
}

const NOTATION_RE = /^\s*(\d+)d(\d+)\s*([+-]\s*\d+)?\s*$/i;

function parseNotation(notation: string): { count: number; sides: number; modifier: number } {
  const m = NOTATION_RE.exec(notation);
  if (!m) {
    throw new Error(`Invalid dice notation: "${notation}". Expected NdM (e.g. 1d20) optionally followed by +K or -K.`);
  }
  const count = Number.parseInt(m[1], 10);
  const sides = Number.parseInt(m[2], 10);
  const modifier = m[3] ? Number.parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
  if (count < 1 || count > 1000) {
    throw new Error(`Dice count out of range (1-1000): ${count}`);
  }
  if (sides < 2 || sides > 1000) {
    throw new Error(`Die sides out of range (2-1000): ${sides}`);
  }
  return { count, sides, modifier };
}

function rollDiceNotation(notation: string, rng: Rng) {
  const { count, sides, modifier } = parseNotation(notation);
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const r = rollDie(rng, sides);
    rolls.push(r);
    sum += r;
  }
  return {
    notation,
    rolls,
    sum,
    modifier,
    total: sum + modifier,
  };
}

function rollStatArray(rng: Rng): { rolls: number[][]; stats: number[] } {
  const statRolls: number[][] = [];
  const stats: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const dice = [rollDie(rng, 6), rollDie(rng, 6), rollDie(rng, 6)];
    // 3d6 drop lowest: sum the top two of three d6.
    const topTwo = [...dice].sort((a, b) => b - a).slice(0, 2);
    statRolls.push(dice);
    stats.push(topTwo[0] + topTwo[1]);
  }
  return { rolls: statRolls, stats };
}

function rollD100(rng: Rng): number {
  return rollDie(rng, 100);
}

function jsonContent(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const diceTool: ToolFactory = () => ({
  name: "dice",
  description:
    "Deterministic dice rolling. roll_dice(notation) parses NdM+K and rolls; roll_stat returns six 3d6-drop-lowest stats; roll_d100 returns 1-100. Pass `seed` for reproducible output.",
  parameters: InputSchema,
  execute: async (params: z.infer<typeof InputSchema>) => {
    const rng = makeRng(params.seed);
    if (params.action === "roll_dice") {
      if (!params.notation) {
        return jsonContent({ error: "notation_required" });
      }
      try {
        const result = rollDiceNotation(params.notation, rng);
        return jsonContent({ action: "roll_dice", seed: params.seed ?? null, ...result });
      } catch (err) {
        return jsonContent({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (params.action === "roll_stat") {
      const result = rollStatArray(rng);
      return jsonContent({ action: "roll_stat", seed: params.seed ?? null, ...result });
    }
    const value = rollD100(rng);
    return jsonContent({ action: "roll_d100", seed: params.seed ?? null, value });
  },
});

export default diceTool;
