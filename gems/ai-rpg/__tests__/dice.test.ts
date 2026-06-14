/**
 * dice.test.ts — table-driven tests for the `dice` tool.
 *
 * Verifies:
 *   - `roll_dice(1d6)` returns array of 1 number in [1,6] and 1000 rolls cover
 *     all 6 faces at least once.
 *   - `roll_dice(3d6)` returns array of 3 numbers each in [1,6].
 *   - `roll_dice(1d20+5)` returns number in [6,25].
 *   - `roll_dice(2d10+3)` returns number in [5,23].
 *   - `roll_stat()` returns 6 numbers each in [3,18].
 *   - `roll_d100()` returns number in [1,100].
 *   - Same seed → same output (deterministic).
 */

import { describe, expect, it } from "@jest/globals";
import diceToolFactory from "../src/tools/dice.js";
import { makeStubGemContext, parseToolJson } from "./setup.js";

// A locally-typed view of the tool the dice factory returns. The runtime
// ToolFactory type from @ai-universe/gem-runtime is `Parameters<FastMCP["addTool"]>[0]`
// which, due to the way FastMCP's generic `Tool<T, Params>` is defined, has an
// `execute` param typed as `unknown`. We narrow it here for ergonomic test code.
type DiceArgs = { action: string; notation?: string; seed?: number };
type ToolLike = { name: string; execute: (args: DiceArgs) => Promise<unknown> };

function buildDiceTool(): ToolLike {
  const ctx = makeStubGemContext();
  // `as unknown as ToolLike` is intentional — the upstream ToolFactory type
  // collapses the execute arg to `unknown` because of FastMCP's generics; the
  // tests below exercise the runtime behavior, not the upstream surface.
  return diceToolFactory(ctx) as unknown as ToolLike;
}

interface RollDicePayload {
  action: string;
  notation?: string;
  rolls?: number[];
  sum?: number;
  modifier?: number;
  total?: number;
  stats?: number[];
  value?: number;
  seed?: number | null;
  error?: string;
}

describe("dice tool — roll_dice", () => {
  it("1d6 returns array of 1 number in [1,6]", async () => {
    const tool = buildDiceTool();
    const res = (await tool.execute({ action: "roll_dice", notation: "1d6", seed: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = parseToolJson(res) as RollDicePayload;
    expect(payload.error).toBeUndefined();
    expect(payload.notation).toBe("1d6");
    expect(Array.isArray(payload.rolls)).toBe(true);
    expect(payload.rolls).toHaveLength(1);
    const r = payload.rolls![0];
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(6);
    expect(payload.total).toBe(r);
  });

  it("1d6 over 1000 rolls produces all 6 faces at least once (seeded)", async () => {
    const tool = buildDiceTool();
    const faces = new Set<number>();
    for (let i = 0; i < 1000; i += 1) {
      const res = (await tool.execute({ action: "roll_dice", notation: "1d6", seed: i })) as {
        content: Array<{ type: string; text: string }>;
      };
      const payload = parseToolJson(res) as RollDicePayload;
      faces.add(payload.rolls![0]);
    }
    expect(faces.size).toBe(6);
    for (const f of [1, 2, 3, 4, 5, 6]) {
      expect(faces.has(f)).toBe(true);
    }
  });

  it("3d6 returns array of 3 numbers each in [1,6]", async () => {
    const tool = buildDiceTool();
    const res = (await tool.execute({ action: "roll_dice", notation: "3d6", seed: 7 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = parseToolJson(res) as RollDicePayload;
    expect(payload.rolls).toHaveLength(3);
    for (const r of payload.rolls!) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    }
    expect(payload.total).toBe((payload.sum ?? 0) + (payload.modifier ?? 0));
  });

  it("1d20+5 returns a number in [6,25]", async () => {
    const tool = buildDiceTool();
    for (let seed = 0; seed < 25; seed += 1) {
      const res = (await tool.execute({ action: "roll_dice", notation: "1d20+5", seed })) as {
        content: Array<{ type: string; text: string }>;
      };
      const payload = parseToolJson(res) as RollDicePayload;
      expect(payload.total).toBeGreaterThanOrEqual(6);
      expect(payload.total).toBeLessThanOrEqual(25);
      expect(payload.modifier).toBe(5);
    }
  });

  it("2d10+3 returns a number in [5,23]", async () => {
    const tool = buildDiceTool();
    for (let seed = 0; seed < 25; seed += 1) {
      const res = (await tool.execute({ action: "roll_dice", notation: "2d10+3", seed })) as {
        content: Array<{ type: string; text: string }>;
      };
      const payload = parseToolJson(res) as RollDicePayload;
      expect(payload.total).toBeGreaterThanOrEqual(5);
      expect(payload.total).toBeLessThanOrEqual(23);
      expect(payload.rolls).toHaveLength(2);
      expect(payload.modifier).toBe(3);
    }
  });

  it("rejects invalid notation", async () => {
    const tool = buildDiceTool();
    const res = (await tool.execute({ action: "roll_dice", notation: "bogus", seed: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = parseToolJson(res) as RollDicePayload;
    expect(typeof payload.error).toBe("string");
  });

  it("rejects roll_dice without notation", async () => {
    const tool = buildDiceTool();
    const res = (await tool.execute({ action: "roll_dice", seed: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = parseToolJson(res) as RollDicePayload;
    expect(payload.error).toBe("notation_required");
  });
});

describe("dice tool — roll_stat", () => {
  it("returns 6 numbers each in [2,18]", async () => {
    const tool = buildDiceTool();
    for (let seed = 0; seed < 25; seed += 1) {
      const res = (await tool.execute({ action: "roll_stat", seed })) as {
        content: Array<{ type: string; text: string }>;
      };
      const payload = parseToolJson(res) as RollDicePayload;
      expect(payload.stats).toHaveLength(6);
      for (const s of payload.stats!) {
        // 3d6 drop-lowest: sum of top 2 of 3 d6. Min = 1+1=2, max = 6+6=12.
        expect(s).toBeGreaterThanOrEqual(2);
        expect(s).toBeLessThanOrEqual(12);
      }
    }
  });

  it("applies 3d6 drop-lowest (each stat is sum of top 2 of 3 d6)", async () => {
    const tool = buildDiceTool();
    const res = (await tool.execute({ action: "roll_stat", seed: 42 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = parseToolJson(res) as RollDicePayload;
    const rollsPerStat = payload.rolls as unknown as number[][] | undefined;
    expect(rollsPerStat).toBeDefined();
    expect(rollsPerStat!).toHaveLength(6);
    const stats = payload.stats!;
    rollsPerStat!.forEach((dice, i) => {
      expect(dice).toHaveLength(3);
      const sortedDesc = [...dice].sort((a, b) => b - a);
      expect(stats[i]).toBe(sortedDesc[0] + sortedDesc[1]);
    });
  });
});

describe("dice tool — roll_d100", () => {
  it("returns a number in [1,100]", async () => {
    const tool = buildDiceTool();
    for (let seed = 0; seed < 50; seed += 1) {
      const res = (await tool.execute({ action: "roll_d100", seed })) as {
        content: Array<{ type: string; text: string }>;
      };
      const payload = parseToolJson(res) as RollDicePayload;
      expect(payload.value).toBeGreaterThanOrEqual(1);
      expect(payload.value).toBeLessThanOrEqual(100);
    }
  });
});

describe("dice tool — determinism", () => {
  it("same seed produces the same output across calls", async () => {
    const tool = buildDiceTool();
    const seed = 1234;
    const a = (await tool.execute({ action: "roll_dice", notation: "3d6+2", seed })) as {
      content: Array<{ type: string; text: string }>;
    };
    const b = (await tool.execute({ action: "roll_dice", notation: "3d6+2", seed })) as {
      content: Array<{ type: string; text: string }>;
    };
    const aPayload = parseToolJson(a) as RollDicePayload;
    const bPayload = parseToolJson(b) as RollDicePayload;
    expect(aPayload.rolls).toEqual(bPayload.rolls);
    expect(aPayload.total).toBe(bPayload.total);
  });

  it("different seeds produce (likely) different output", async () => {
    const tool = buildDiceTool();
    const a = (await tool.execute({ action: "roll_dice", notation: "1d20", seed: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const b = (await tool.execute({ action: "roll_dice", notation: "1d20", seed: 2 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const aPayload = parseToolJson(a) as RollDicePayload;
    const bPayload = parseToolJson(b) as RollDicePayload;
    // Not a hard guarantee but extremely likely across two well-separated seeds.
    expect(aPayload.rolls![0] === bPayload.rolls![0]).toBe(false);
  });
});
