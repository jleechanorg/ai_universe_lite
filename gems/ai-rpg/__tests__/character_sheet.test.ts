/**
 * character_sheet.test.ts — D&D 5e character CRUD via makeStubGemContext.
 *
 * Verifies the create / read / update / level_up actions on the
 * `character_sheet` tool. Each tool factory is module-scoped in the source,
 * so the in-memory `characterStore` persists across test cases inside a single
 * test-file run — we use unique characterIds per test to stay isolated.
 */

import { describe, expect, it } from "@jest/globals";
import characterSheetToolFactory from "../src/tools/character_sheet.js";
import { makeStubGemContext, parseToolJson, SAMPLE_STATS, SAMPLE_MODS } from "./setup.js";

type ToolLike = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

function buildTool(): ToolLike {
  const ctx = makeStubGemContext();
  return characterSheetToolFactory(ctx) as unknown as ToolLike;
}

interface CharacterPayload {
  characterId: string;
  name: string;
  class: string;
  race: string;
  background: string;
  level: number;
  stats: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  statMods: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  hp: number;
  maxHp: number;
  backstory?: string;
  leveledUpTo?: number;
  hpGain?: number;
  error?: string;
}

function asCharacter(payload: unknown): CharacterPayload {
  return payload as CharacterPayload;
}

const EXPECTED_MOD_ARRAY = [
  SAMPLE_MODS.str,
  SAMPLE_MODS.dex,
  SAMPLE_MODS.con,
  SAMPLE_MODS.int,
  SAMPLE_MODS.wis,
  SAMPLE_MODS.cha,
];

describe("character_sheet tool — create", () => {
  it("computes mods [+3,+2,+1,+1,+2,+0], HP=11, level=1 for SAMPLE_STATS", async () => {
    const tool = buildTool();
    const characterId = `hero-create-${Date.now()}`;
    const res = (await tool.execute({
      action: "create",
      characterId,
      name: "Aria the Bold",
      class: "Ranger",
      race: "Half-Elf",
      background: "Outlander",
      stats: SAMPLE_STATS,
    })) as { content: Array<{ type: string; text: string }> };

    const payload = asCharacter(parseToolJson(res));
    expect(payload.error).toBeUndefined();
    expect(payload.characterId).toBe(characterId);
    expect(payload.name).toBe("Aria the Bold");
    expect(payload.class).toBe("Ranger");
    expect(payload.race).toBe("Half-Elf");
    expect(payload.background).toBe("Outlander");
    expect(payload.level).toBe(1);

    // 5e mod = floor((score-10)/2): 16→+3, 14→+2, 13→+1, 12→+1, 15→+2, 10→+0.
    expect([
      payload.statMods.str,
      payload.statMods.dex,
      payload.statMods.con,
      payload.statMods.int,
      payload.statMods.wis,
      payload.statMods.cha,
    ]).toEqual(EXPECTED_MOD_ARRAY);

    // L1 HP = 10 + CON mod = 10 + 1 = 11.
    expect(payload.hp).toBe(11);
    expect(payload.maxHp).toBe(11);

    // Stats round-trip.
    expect(payload.stats).toEqual(SAMPLE_STATS);

    // The stub LLM returns "" → tool returns the character payload without a
    // backstory (the source only assigns a fallback on thrown errors, not on
    // empty-string returns). Backstory is purely an LLM-driven field.
    expect(payload.backstory).toBeUndefined();
  });
});

describe("character_sheet tool — read", () => {
  it("returns the same character that was just created", async () => {
    const tool = buildTool();
    const characterId = `hero-read-${Date.now()}`;

    const created = (await tool.execute({
      action: "create",
      characterId,
      name: "Borrik Stone",
      class: "Cleric",
      race: "Dwarf",
      background: "Acolyte",
      stats: SAMPLE_STATS,
    })) as { content: Array<{ type: string; text: string }> };
    const createdPayload = asCharacter(parseToolJson(created));

    const readRes = (await tool.execute({
      action: "read",
      characterId,
    })) as { content: Array<{ type: string; text: string }> };
    const readPayload = asCharacter(parseToolJson(readRes));

    expect(readPayload.error).toBeUndefined();
    expect(readPayload.characterId).toBe(characterId);
    expect(readPayload.name).toBe(createdPayload.name);
    expect(readPayload.class).toBe(createdPayload.class);
    expect(readPayload.race).toBe(createdPayload.race);
    expect(readPayload.level).toBe(1);
    expect(readPayload.stats).toEqual(SAMPLE_STATS);
    expect([
      readPayload.statMods.str,
      readPayload.statMods.dex,
      readPayload.statMods.con,
      readPayload.statMods.int,
      readPayload.statMods.wis,
      readPayload.statMods.cha,
    ]).toEqual(EXPECTED_MOD_ARRAY);
    expect(readPayload.hp).toBe(11);
    expect(readPayload.maxHp).toBe(11);
  });

  it("returns character_not_found for an unknown id", async () => {
    const tool = buildTool();
    const res = (await tool.execute({
      action: "read",
      characterId: "does-not-exist-xyz",
    })) as { content: Array<{ type: string; text: string }> };
    const payload = asCharacter(parseToolJson(res));
    expect(typeof payload.error).toBe("string");
    expect(payload.error).toContain("character_not_found");
  });
});

describe("character_sheet tool — update", () => {
  it("mutates stats and recomputes mods", async () => {
    const tool = buildTool();
    const characterId = `hero-update-${Date.now()}`;
    await tool.execute({
      action: "create",
      characterId,
      name: "Cara",
      class: "Rogue",
      race: "Halfling",
      background: "Urchin",
      stats: SAMPLE_STATS,
    });

    // Crank STR from 16 to 18 (mod +3 -> +4); CHA from 10 to 7 (mod 0 -> -2).
    const res = (await tool.execute({
      action: "update",
      characterId,
      stats: { ...SAMPLE_STATS, str: 18, cha: 7 },
    })) as { content: Array<{ type: string; text: string }> };
    const payload = asCharacter(parseToolJson(res));

    expect(payload.error).toBeUndefined();
    expect(payload.stats.str).toBe(18);
    expect(payload.stats.cha).toBe(7);
    expect(payload.statMods.str).toBe(4); // (18-10)/2 floored
    expect(payload.statMods.cha).toBe(-2); // (7-10)/2 floored = -1.5 → -2
    // Other stats unchanged.
    expect(payload.statMods.dex).toBe(2);
    expect(payload.statMods.con).toBe(1);
    expect(payload.statMods.int).toBe(1);
    expect(payload.statMods.wis).toBe(2);
  });

  it("updates name/class/race/background and preserves HP ratio when stats change", async () => {
    const tool = buildTool();
    const characterId = `hero-update-meta-${Date.now()}`;
    await tool.execute({
      action: "create",
      characterId,
      name: "Dren",
      class: "Fighter",
      race: "Human",
      background: "Soldier",
      stats: SAMPLE_STATS,
    });

    const res = (await tool.execute({
      action: "update",
      characterId,
      name: "Dren the Brave",
      class: "Paladin",
      race: "Dragonborn",
      background: "Knight",
      stats: { ...SAMPLE_STATS, con: 18 }, // +1 → +4 mod
    })) as { content: Array<{ type: string; text: string }> };
    const payload = asCharacter(parseToolJson(res));

    expect(payload.name).toBe("Dren the Brave");
    expect(payload.class).toBe("Paladin");
    expect(payload.race).toBe("Dragonborn");
    expect(payload.background).toBe("Knight");
    expect(payload.statMods.con).toBe(4);
    // L1 HP recomputed: 10 + 4 = 14; ratio was 11/11 = 1.0, so hp stays at 14.
    expect(payload.maxHp).toBe(14);
    expect(payload.hp).toBe(14);
  });
});

describe("character_sheet tool — level_up", () => {
  it("increments level and adds 5+CON_mod to HP", async () => {
    const tool = buildTool();
    const characterId = `hero-levelup-${Date.now()}`;
    await tool.execute({
      action: "create",
      characterId,
      name: "Elara",
      class: "Wizard",
      race: "Elf",
      background: "Sage",
      stats: SAMPLE_STATS, // CON = 13 → mod +1
    });

    const res = (await tool.execute({
      action: "level_up",
      characterId,
    })) as { content: Array<{ type: string; text: string }> };
    const payload = asCharacter(parseToolJson(res));

    expect(payload.error).toBeUndefined();
    expect(payload.level).toBe(2);
    expect(payload.leveledUpTo).toBe(2);
    // hpGain = max(1, 5 + 1) = 6.
    expect(payload.hpGain).toBe(6);
    // HP was 11 (from create), now 11 + 6 = 17; maxHp 11 + 6 = 17.
    expect(payload.hp).toBe(17);
    expect(payload.maxHp).toBe(17);
  });

  it("hpGain is 5+CON_mod even for high CON (e.g. CON=18 → mod +4, gain=9)", async () => {
    const tool = buildTool();
    const characterId = `hero-levelup-tank-${Date.now()}`;
    await tool.execute({
      action: "create",
      characterId,
      name: "Grom",
      class: "Barbarian",
      race: "Goliath",
      background: "Hermit",
      stats: { ...SAMPLE_STATS, con: 18 }, // mod +4
    });

    const res = (await tool.execute({
      action: "level_up",
      characterId,
    })) as { content: Array<{ type: string; text: string }> };
    const payload = asCharacter(parseToolJson(res));

    expect(payload.level).toBe(2);
    expect(payload.hpGain).toBe(9);
    // L1 HP = 10 + 4 = 14; +9 = 23.
    expect(payload.hp).toBe(23);
    expect(payload.maxHp).toBe(23);
  });
});
