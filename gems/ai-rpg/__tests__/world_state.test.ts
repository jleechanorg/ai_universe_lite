/**
 * world_state.test.ts — per-intake world state via the `world_state` tool.
 *
 * The state map is held at module scope in `world_state.ts`; we use a
 * per-test intakeId (suffixed with `Date.now()`) to stay isolated.
 *
 * Coverage:
 *   - set + get roundtrip preserves location + npcs + timeOfDay.
 *   - add_npc appends to the npcs array.
 *   - advance_time cycles dawn → morning → noon → afternoon → evening →
 *     night → midnight → dawn (7 stages, then wraps).
 */

import { describe, expect, it } from "@jest/globals";
import worldStateToolFactory from "../src/tools/world_state.js";
import { makeStubGemContext, parseToolJson } from "./setup.js";

type ToolLike = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

function buildTool(): ToolLike {
  const ctx = makeStubGemContext();
  return worldStateToolFactory(ctx) as unknown as ToolLike;
}

interface WorldStatePayload {
  intakeId: string;
  location: string;
  npcs: Array<{ name: string; role: string; disposition: string }>;
  timeOfDay: "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night" | "midnight";
  updatedAt: string;
  error?: string;
}

async function runState(tool: ToolLike, args: Record<string, unknown>): Promise<WorldStatePayload> {
  const res = (await tool.execute(args)) as {
    content: Array<{ type: string; text: string }>;
  };
  return parseToolJson(res) as WorldStatePayload;
}

describe("world_state tool — set + get roundtrip", () => {
  it("set then get preserves location, npcs, and timeOfDay", async () => {
    const tool = buildTool();
    const intakeId = `ws-roundtrip-${Date.now()}`;
    const npcs = [
      { name: "Brom Ironbeard", role: "blacksmith", disposition: "friendly" },
      { name: "Sera Nightwhisper", role: "rogue", disposition: "wary" },
    ];

    const setRes = await runState(tool, {
      action: "set",
      intakeId,
      state: { location: "Riverdell Tavern", npcs },
    });
    expect(setRes.error).toBeUndefined();
    expect(setRes.intakeId).toBe(intakeId);
    expect(setRes.location).toBe("Riverdell Tavern");
    expect(setRes.npcs).toEqual(npcs);
    // Default time-of-day is "dawn" on first interaction.
    expect(setRes.timeOfDay).toBe("dawn");

    const getRes = await runState(tool, { action: "get", intakeId });
    expect(getRes.error).toBeUndefined();
    expect(getRes.location).toBe("Riverdell Tavern");
    expect(getRes.npcs).toEqual(npcs);
    expect(getRes.timeOfDay).toBe("dawn");
  });

  it("get on a fresh intakeId auto-initializes with defaults", async () => {
    const tool = buildTool();
    const intakeId = `ws-fresh-${Date.now()}`;
    const r = await runState(tool, { action: "get", intakeId });
    expect(r.error).toBeUndefined();
    expect(r.location).toBe("Unknown");
    expect(r.npcs).toEqual([]);
    expect(r.timeOfDay).toBe("dawn");
  });

  it("set without `state` returns state_required", async () => {
    const tool = buildTool();
    const intakeId = `ws-badset-${Date.now()}`;
    const r = await runState(tool, { action: "set", intakeId });
    expect(r.error).toBe("state_required");
  });
});

describe("world_state tool — add_npc appends", () => {
  it("appends to the existing npcs array and preserves location", async () => {
    const tool = buildTool();
    const intakeId = `ws-addnpc-${Date.now()}`;

    await runState(tool, {
      action: "set",
      intakeId,
      state: {
        location: "Drowned Temple",
        npcs: [{ name: "Whisperwind", role: "spirit", disposition: "neutral" }],
      },
    });

    const r = await runState(tool, {
      action: "add_npc",
      intakeId,
      npc: { name: "Captain Vex", role: "guard", disposition: "hostile" },
    });
    expect(r.error).toBeUndefined();
    expect(r.location).toBe("Drowned Temple");
    expect(r.npcs).toEqual([
      { name: "Whisperwind", role: "spirit", disposition: "neutral" },
      { name: "Captain Vex", role: "guard", disposition: "hostile" },
    ]);

    // And a second append keeps the prior two.
    const r2 = await runState(tool, {
      action: "add_npc",
      intakeId,
      npc: { name: "Mira", role: "scholar", disposition: "curious" },
    });
    expect(r2.npcs).toHaveLength(3);
    expect(r2.npcs[2]).toEqual({ name: "Mira", role: "scholar", disposition: "curious" });
  });

  it("add_npc on a fresh intakeId starts from an empty npcs array", async () => {
    const tool = buildTool();
    const intakeId = `ws-addnpc-fresh-${Date.now()}`;
    const r = await runState(tool, {
      action: "add_npc",
      intakeId,
      npc: { name: "Old Tom", role: "innkeeper", disposition: "friendly" },
    });
    expect(r.npcs).toEqual([{ name: "Old Tom", role: "innkeeper", disposition: "friendly" }]);
  });

  it("add_npc without an npc returns npc_required", async () => {
    const tool = buildTool();
    const intakeId = `ws-addnpc-bad-${Date.now()}`;
    const r = await runState(tool, { action: "add_npc", intakeId });
    expect(r.error).toBe("npc_required");
  });
});

describe("world_state tool — advance_time cycle", () => {
  it("cycles dawn → morning → noon → afternoon → evening → night → midnight → dawn", async () => {
    const tool = buildTool();
    const intakeId = `ws-time-${Date.now()}`;

    // Fresh intake starts at "dawn" by default.
    const initial = await runState(tool, { action: "get", intakeId });
    expect(initial.timeOfDay).toBe("dawn");

    const expected: WorldStatePayload["timeOfDay"][] = [
      "morning",
      "noon",
      "afternoon",
      "evening",
      "night",
      "midnight",
      "dawn",
    ];

    for (const next of expected) {
      const r = await runState(tool, { action: "advance_time", intakeId });
      expect(r.error).toBeUndefined();
      expect(r.timeOfDay).toBe(next);
    }
  });

  it("advance_time wraps back to dawn after a full cycle", async () => {
    const tool = buildTool();
    const intakeId = `ws-time-wrap-${Date.now()}`;
    // 7 advances covers a full 7-stage cycle.
    for (let i = 0; i < 7; i += 1) {
      await runState(tool, { action: "advance_time", intakeId });
    }
    const r = await runState(tool, { action: "advance_time", intakeId });
    // After 8 advances from dawn, we should be back at "morning" (the 8th
    // advance takes us from "dawn" -> "morning").
    expect(r.timeOfDay).toBe("morning");
  });
});
