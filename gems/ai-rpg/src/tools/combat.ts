// combat.ts — D&D 5e-style attack resolution.
//
// Math: roll d20 + attackBonus vs target AC.
//   - Natural 20 → auto-hit + crit (double damage dice, not modifier).
//   - Natural 1  → auto-miss regardless of bonuses.
//   - advantage  → roll twice, take the higher d20 (still subject to nat 1 / nat 20).
//   - disadvantage → roll twice, take the lower d20.
//   - On hit: roll damage per `attacker.damage` notation (e.g. "1d8+3") and apply to target.hp.
//   - When target.hp <= 0: set `dead: true` and `deathSave: true`.
//
// Damage parsing reuses the notation grammar from the `dice` tool but is
// performed inline here to keep combat deterministic without a second tool call.

import { z } from "zod";
import type { ToolFactory } from "@ai-universe/gem-runtime";

const AttackerSchema = z.object({
  name: z.string().min(1),
  attackBonus: z.number().int(),
  damage: z.string().min(1),
  damageType: z.string().min(1),
});

const TargetSchema = z.object({
  name: z.string().min(1),
  ac: z.number().int().min(0),
  hp: z.number().int().min(0),
  maxHp: z.number().int().min(0),
});

const InputSchema = z.object({
  attacker: AttackerSchema,
  target: TargetSchema,
  advantage: z.boolean().optional(),
  disadvantage: z.boolean().optional(),
  status: z.array(z.string()).optional(),
});

const NOTATION_RE = /^\s*(\d+)d(\d+)\s*([+-]\s*\d+)?\s*$/i;

function parseNotation(notation: string): { count: number; sides: number; modifier: number } {
  const m = NOTATION_RE.exec(notation);
  if (!m) {
    throw new Error(`Invalid damage notation: "${notation}". Expected NdM (e.g. 1d8) optionally followed by +K or -K.`);
  }
  const count = Number.parseInt(m[1], 10);
  const sides = Number.parseInt(m[2], 10);
  const modifier = m[3] ? Number.parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
  if (count < 1 || count > 100) {
    throw new Error(`Damage dice count out of range (1-100): ${count}`);
  }
  if (sides < 2 || sides > 1000) {
    throw new Error(`Damage die sides out of range (2-1000): ${sides}`);
  }
  return { count, sides, modifier };
}

// Local PRNG so combat is deterministic when a seed is provided via the status
// array (e.g. status: ["seed:42"]). Falls back to Math.random.
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

function pickRng(status: string[] | undefined): Rng {
  if (!status) return Math.random;
  for (const token of status) {
    const m = /^seed:(\d+)$/i.exec(token.trim());
    if (m) {
      const seed = Number.parseInt(m[1], 10);
      if (Number.isFinite(seed) && seed >= 0) return mulberry32(seed);
    }
  }
  return Math.random;
}

function rollD20(rng: Rng): number {
  return Math.floor(rng() * 20) + 1;
}

function rollDamage(rng: Rng, notation: string, doubleDice: boolean): { rolls: number[]; modifier: number; total: number } {
  const { count, sides, modifier } = parseNotation(notation);
  const diceCount = doubleDice ? count * 2 : count;
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < diceCount; i += 1) {
    const r = Math.floor(rng() * sides) + 1;
    rolls.push(r);
    sum += r;
  }
  return { rolls, modifier, total: sum + modifier };
}

function jsonContent(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const combatTool: ToolFactory = () => ({
  name: "combat",
  description:
    "D&D 5e attack resolution. Rolls d20+attackBonus vs AC. Natural 20 = crit (double damage dice). Natural 1 = auto-miss. advantage/disadvantage supported. Damage applied to target.hp; on 0 HP, marks dead and starts death saves.",
  parameters: InputSchema,
  execute: async (params: z.infer<typeof InputSchema>) => {
    const { attacker, target, advantage, disadvantage, status } = params;
    const rng = pickRng(status);
    const hasAdv = Boolean(advantage) && !disadvantage;
    const hasDis = Boolean(disadvantage) && !advantage;

    const firstRoll = rollD20(rng);
    let chosenRoll = firstRoll;
    let usedRoll = firstRoll;
    let advDisRolls: number[] | undefined;
    if (hasAdv || hasDis) {
      const secondRoll = rollD20(rng);
      advDisRolls = [firstRoll, secondRoll];
      chosenRoll = hasAdv ? Math.max(firstRoll, secondRoll) : Math.min(firstRoll, secondRoll);
      usedRoll = chosenRoll;
    }

    const totalAttack = usedRoll + attacker.attackBonus;
    const isCrit = usedRoll === 20;
    const isFumble = usedRoll === 1;
    const autoHit = isCrit;
    const autoMiss = isFumble;
    const hit = !autoMiss && (autoHit || totalAttack >= target.ac);

    if (!hit) {
      return jsonContent({
        roll: usedRoll,
        attackRoll: totalAttack,
        ac: target.ac,
        hit: false,
        missReason: autoMiss ? "fumble" : "below_ac",
        attacker: attacker.name,
        target: target.name,
        targetHp: target.hp,
        advDisRolls,
      });
    }

    const dmg = rollDamage(rng, attacker.damage, isCrit);
    const newHp = Math.max(0, target.hp - dmg.total);
    const dead = newHp <= 0;

    return jsonContent({
      roll: usedRoll,
      attackRoll: totalAttack,
      ac: target.ac,
      hit: true,
      crit: isCrit,
      damage: dmg.total,
      damageRolls: dmg.rolls,
      damageModifier: dmg.modifier,
      damageType: attacker.damageType,
      attacker: attacker.name,
      target: target.name,
      targetHp: newHp,
      targetMaxHp: target.maxHp,
      dead,
      deathSave: dead,
      advDisRolls,
    });
  },
});

export default combatTool;
