// character_sheet.ts — D&D 5e-style character CRUD with deterministic HP math.
//
// Pure logic for create/read/update/level-up; the LLM is invoked ONLY for the
// optional 1-paragraph backstory that comes back on `create`.
//
// HP rules:
//   - L1 HP = 10 + CON mod (d8 hit die → flat 10 for simplicity)
//   - Level-up HP gain = 5 + CON mod (average of d8)
//   - CON mod = floor((con - 10) / 2)

import { z } from "zod";
import type { ToolFactory } from "@ai-universe/gem-runtime";

const BACKSTORY_MODEL = "claude-3-5-haiku-20241022";

const StatsSchema = z.object({
  str: z.number().int().min(1).max(30),
  dex: z.number().int().min(1).max(30),
  con: z.number().int().min(1).max(30),
  int: z.number().int().min(1).max(30),
  wis: z.number().int().min(1).max(30),
  cha: z.number().int().min(1).max(30),
});

const InputSchema = z.object({
  action: z.enum(["create", "read", "update", "level_up"]),
  characterId: z.string().min(1),
  name: z.string().optional(),
  class: z.string().optional(),
  race: z.string().optional(),
  background: z.string().optional(),
  stats: StatsSchema.optional(),
});

type Character = {
  characterId: string;
  name: string;
  class: string;
  race: string;
  background: string;
  level: number;
  stats: z.infer<typeof StatsSchema>;
  statMods: Record<keyof z.infer<typeof StatsSchema>, number>;
  hp: number;
  maxHp: number;
  backstory?: string;
};

const characterStore = new Map<string, Character>();

function statMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

function statMods(stats: z.infer<typeof StatsSchema>) {
  return {
    str: statMod(stats.str),
    dex: statMod(stats.dex),
    con: statMod(stats.con),
    int: statMod(stats.int),
    wis: statMod(stats.wis),
    cha: statMod(stats.cha),
  };
}

function jsonContent(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const characterSheetTool: ToolFactory = (ctx) => ({
  name: "character_sheet",
  description:
    "D&D 5e-style character CRUD. create/read/update/level_up. HP auto-calculated from CON. LLM is called only on `create` to generate a 1-paragraph backstory.",
  parameters: InputSchema,
  execute: async (params: z.infer<typeof InputSchema>) => {
    const { action, characterId } = params;

    if (action === "create") {
      const name = params.name ?? "Unnamed Hero";
      const klass = params.class ?? "Adventurer";
      const race = params.race ?? "Human";
      const background = params.background ?? "Wanderer";
      const stats = params.stats ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
      const mods = statMods(stats);
      const maxHp = 10 + mods.con;
      const character: Character = {
        characterId,
        name,
        class: klass,
        race,
        background,
        level: 1,
        stats,
        statMods: mods,
        hp: maxHp,
        maxHp,
      };
      characterStore.set(characterId, character);

      let backstory: string | undefined;
      try {
        const prompt = `Write a single short paragraph (3-5 sentences) of backstory for a level-1 ${race} ${klass} named ${name} with background "${background}". Stats: STR ${stats.str}, DEX ${stats.dex}, CON ${stats.con}, INT ${stats.int}, WIS ${stats.wis}, CHA ${stats.cha}. Tone: evocative, second-person, no game-mechanics jargon.`;
        const text = await ctx.callLlm(BACKSTORY_MODEL, prompt);
        if (text && text.trim().length > 0) {
          backstory = text.trim();
          character.backstory = backstory;
        }
      } catch {
        // Backstory is optional; fall back to deterministic summary.
        backstory = `${name} is a level-1 ${race} ${klass} with a ${background} past, whose story is still being written.`;
        character.backstory = backstory;
      }

      return jsonContent({ ...character, backstory });
    }

    const existing = characterStore.get(characterId);
    if (!existing) {
      return jsonContent({ error: `character_not_found: ${characterId}` });
    }

    if (action === "read") {
      return jsonContent({ ...existing });
    }

    if (action === "update") {
      if (params.name !== undefined) existing.name = params.name;
      if (params.class !== undefined) existing.class = params.class;
      if (params.race !== undefined) existing.race = params.race;
      if (params.background !== undefined) existing.background = params.background;
      if (params.stats) {
        existing.stats = params.stats;
        existing.statMods = statMods(params.stats);
        // Recompute HP using the new CON mod, preserving current HP ratio.
        const conMod = existing.statMods.con;
        const newMaxHp = 10 + conMod + (existing.level - 1) * (5 + conMod);
        const ratio = existing.maxHp > 0 ? existing.hp / existing.maxHp : 1;
        existing.maxHp = newMaxHp;
        existing.hp = Math.max(0, Math.min(newMaxHp, Math.round(newMaxHp * ratio)));
      }
      characterStore.set(characterId, existing);
      return jsonContent({ ...existing });
    }

    // level_up
    existing.level += 1;
    const conMod = existing.statMods.con;
    const hpGain = Math.max(1, 5 + conMod);
    existing.maxHp += hpGain;
    existing.hp += hpGain;
    characterStore.set(characterId, existing);
    return jsonContent({ ...existing, leveledUpTo: existing.level, hpGain });
  },
});

export default characterSheetTool;
