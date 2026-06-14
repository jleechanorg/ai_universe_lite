/**
 * combat.test.ts — D&D 5e attack resolution via the `combat` tool.
 *
 * The combat tool reads seeds from the `status` array (e.g. `status: ["seed:42"]`)
 * so every test is deterministic. The PRNG used is mulberry32, which lives
 * inline in `combat.ts` — when a seed is provided the same input always
 * produces the same rolls.
 *
 * Coverage:
 *   - Standard attack rolls d20 + attackBonus vs target AC, deterministic.
 *   - Advantage rolls 2d20, takes the higher.
 *   - Disadvantage rolls 2d20, takes the lower.
 *   - Natural 20 doubles damage dice (crit).
 *   - Natural 1 auto-misses regardless of bonuses.
 *   - HP at 0 → dead: true and deathSave: true.
 */

import { describe, expect, it } from "@jest/globals";
import combatToolFactory from "../src/tools/combat.js";
import { makeStubGemContext, parseToolJson } from "./setup.js";

type ToolLike = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

function buildTool(): ToolLike {
  const ctx = makeStubGemContext();
  return combatToolFactory(ctx) as unknown as ToolLike;
}

interface CombatPayload {
  roll: number;
  attackRoll: number;
  ac: number;
  hit: boolean;
  missReason?: string;
  crit?: boolean;
  damage?: number;
  damageRolls?: number[];
  damageModifier?: number;
  damageType?: string;
  attacker: string;
  target: string;
  targetHp: number;
  targetMaxHp: number;
  dead?: boolean;
  deathSave?: boolean;
  advDisRolls?: number[];
}

const attacker = {
  name: "Aria",
  attackBonus: 5,
  damage: "1d8+3",
  damageType: "slashing",
};
const target = { name: "Goblin", ac: 14, hp: 20, maxHp: 20 };

async function runAttack(
  tool: ToolLike,
  overrides: Record<string, unknown> = {},
): Promise<CombatPayload> {
  const res = (await tool.execute({
    attacker,
    target,
    ...overrides,
  })) as { content: Array<{ type: string; text: string }> };
  return parseToolJson(res) as CombatPayload;
}

describe("combat tool — deterministic standard attack", () => {
  it("same seed produces same roll + damage every time", async () => {
    const tool = buildTool();
    const a = await runAttack(tool, { status: ["seed:42"] });
    const b = await runAttack(tool, { status: ["seed:42"] });
    expect(a.roll).toBe(b.roll);
    expect(a.attackRoll).toBe(b.attackRoll);
    expect(a.damage).toBe(b.damage);
    expect(a.damageRolls).toEqual(b.damageRolls);
    expect(a.hit).toBe(b.hit);
  });

  it("roll is in [1,20] and total is roll + attackBonus", async () => {
    const tool = buildTool();
    for (let seed = 0; seed < 25; seed += 1) {
      const r = await runAttack(tool, { status: [`seed:${seed}`] });
      expect(r.roll).toBeGreaterThanOrEqual(1);
      expect(r.roll).toBeLessThanOrEqual(20);
      expect(r.attackRoll).toBe(r.roll + attacker.attackBonus);
    }
  });
});

describe("combat tool — advantage / disadvantage", () => {
  it("advantage rolls 2d20 and takes the higher", async () => {
    const tool = buildTool();
    const r = await runAttack(tool, { advantage: true, status: ["seed:7"] });
    expect(r.advDisRolls).toBeDefined();
    expect(r.advDisRolls).toHaveLength(2);
    const [a, b] = r.advDisRolls as number[];
    expect(r.roll).toBe(Math.max(a, b));
    expect(r.attackRoll).toBe(r.roll + attacker.attackBonus);
  });

  it("disadvantage rolls 2d20 and takes the lower", async () => {
    const tool = buildTool();
    const r = await runAttack(tool, { disadvantage: true, status: ["seed:7"] });
    expect(r.advDisRolls).toBeDefined();
    expect(r.advDisRolls).toHaveLength(2);
    const [a, b] = r.advDisRolls as number[];
    expect(r.roll).toBe(Math.min(a, b));
    expect(r.attackRoll).toBe(r.roll + attacker.attackBonus);
  });

  it("without advantage or disadvantage, only one d20 is rolled", async () => {
    const tool = buildTool();
    const r = await runAttack(tool, { status: ["seed:7"] });
    expect(r.advDisRolls).toBeUndefined();
  });
});

describe("combat tool — natural 20 crit", () => {
  it("crit doubles damage dice (roll count is doubled)", async () => {
    const tool = buildTool();
    // Scan seeds until we find a natural 20.
    let found: CombatPayload | undefined;
    for (let seed = 0; seed < 200; seed += 1) {
      const r = await runAttack(tool, { status: [`seed:${seed}`] });
      if (r.roll === 20) {
        found = r;
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.crit).toBe(true);
    expect(found!.hit).toBe(true);
    // 1d8+3 crit → 2d8+3, so damageRolls has length 2 (not 1).
    expect(found!.damageRolls).toBeDefined();
    expect(found!.damageRolls!).toHaveLength(2);
    expect(found!.damageModifier).toBe(3);
    // Sum of 2d8 + 3 must be in [5, 19].
    expect(found!.damage).toBeGreaterThanOrEqual(5);
    expect(found!.damage).toBeLessThanOrEqual(19);
  });

  it("nat 20 with very low attack bonus still hits (auto-hit on crit)", async () => {
    const tool = buildTool();
    let found: CombatPayload | undefined;
    for (let seed = 0; seed < 200; seed += 1) {
      const r = await runAttack(tool, {
        attacker: { ...attacker, attackBonus: -10 },
        target: { ...target, ac: 30 }, // impossible to hit via normal math
        status: [`seed:${seed}`],
      });
      if (r.roll === 20) {
        found = r;
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.crit).toBe(true);
    expect(found!.hit).toBe(true);
  });
});

describe("combat tool — natural 1 fumble", () => {
  it("nat 1 auto-misses even with huge attack bonus", async () => {
    const tool = buildTool();
    let found: CombatPayload | undefined;
    for (let seed = 0; seed < 200; seed += 1) {
      const r = await runAttack(tool, {
        attacker: { ...attacker, attackBonus: 1000 },
        target: { ...target, ac: -100 },
        status: [`seed:${seed}`],
      });
      if (r.roll === 1) {
        found = r;
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.hit).toBe(false);
    expect(found!.missReason).toBe("fumble");
    expect(found!.damage).toBeUndefined();
  });
});

describe("combat tool — death at 0 HP", () => {
  it("reduces target HP, sets dead: true and deathSave: true when HP hits 0", async () => {
    const tool = buildTool();
    const fragile = { name: "Kobold", ac: 5, hp: 1, maxHp: 5 };
    // Force a hit by giving the attacker a huge attack bonus, then sweep
    // seeds until the nat-1 fumble case is avoided.
    let found: CombatPayload | undefined;
    for (let seed = 0; seed < 200; seed += 1) {
      const r = await runAttack(tool, {
        attacker: { ...attacker, attackBonus: 50, damage: "1d8+10" },
        target: fragile,
        status: [`seed:${seed}`],
      });
      if (r.hit && r.targetHp === 0) {
        found = r;
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.targetHp).toBe(0);
    expect(found!.dead).toBe(true);
    expect(found!.deathSave).toBe(true);
  });

  it("does not flag dead when target HP is still above 0", async () => {
    const tool = buildTool();
    const sturdy = { name: "Ogre", ac: 5, hp: 100, maxHp: 100 };
    let found: CombatPayload | undefined;
    for (let seed = 0; seed < 200; seed += 1) {
      const r = await runAttack(tool, {
        attacker: { ...attacker, attackBonus: 50, damage: "1d4+1" },
        target: sturdy,
        status: [`seed:${seed}`],
      });
      if (r.hit && r.targetHp > 0) {
        found = r;
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.targetHp).toBeGreaterThan(0);
    expect(found!.dead).toBe(false);
    expect(found!.deathSave).toBe(false);
  });
});
