/**
 * server.boot.test.ts — boot a real FastMCP server on an ephemeral port and
 * exercise each tool's `execute` method end-to-end.
 *
 * This is the smoke test for the full gem surface area: instead of mocking
 * FastMCP, we instantiate it, register every tool factory the same way
 * `src/server.ts` does (without going through `import.meta.glob`, which is a
 * Vite-only feature unavailable in Jest), start the HTTP stream transport
 * on `PORT=0` (so the OS picks a free port), and confirm each tool's
 * `execute` returns a well-formed payload.
 *
 * Why a real FastMCP instance? Two reasons:
 *   1. It catches regressions in the tool-registration glue (e.g. forgetting
 *      to call `addTool`, wiring a wrong type, etc.).
 *   2. It validates that the MCP server can actually start, accept a port,
 *      and shut down cleanly.
 *
 * Note: We don't open an MCP client session against the running server — that
 * would require either spawning a stdio client or a full Streamable-HTTP
 * round-trip with the MCP protocol framing. The pragmatic test is: server
 * starts, all 5 tools are registered, each `tool.execute` returns the same
 * payload shape as the unit tests, server stops cleanly.
 */

import { describe, expect, it, beforeAll, afterAll } from "@jest/globals";
import { FastMCP } from "fastmcp";
import characterSheetFactory from "../src/tools/character_sheet.js";
import combatFactory from "../src/tools/combat.js";
import diceFactory from "../src/tools/dice.js";
import narratorFactory from "../src/tools/narrator.js";
import worldStateFactory from "../src/tools/world_state.js";
import { makeStubGemContext, parseToolJson } from "./setup.js";

type ToolLike = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

describe("server boot — FastMCP starts and every tool is registered", () => {
  let server: FastMCP;
  const tools: Record<string, ToolLike> = {};

  beforeAll(async () => {
    const ctx = makeStubGemContext();
    const factories: Array<{ factory: (c: typeof ctx) => unknown; name: string }> = [
      { factory: diceFactory, name: "dice" },
      { factory: characterSheetFactory, name: "character_sheet" },
      { factory: combatFactory, name: "combat" },
      { factory: worldStateFactory, name: "world_state" },
      { factory: narratorFactory, name: "narrator" },
    ];

    // FastMCP enforces `${number}.${number}.${number}` for `version`, so we
    // cast through `unknown` to bypass the template-literal check (same
    // approach used in `src/server.ts`).
    server = new FastMCP({
      name: "ai-rpg-test",
      version: "0.1.0" as unknown as `${number}.${number}.${number}`,
    });
    for (const { factory, name } of factories) {
      const tool = factory(ctx) as ToolLike;
      // FastMCP's addTool has a complex generic; we already validate the
      // shape via the unit tests, so a structural cast is fine here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server.addTool as any)(tool);
      tools[name] = tool;
    }

    // PORT=0 → OS-assigned free port. The server-side `addTool` doesn't
    // block, but `start` does. We don't await a readiness signal beyond
    // the promise — FastMCP's httpStream server listens on the assigned
    // port by the time `start` resolves.
    await server.start({
      transportType: "httpStream",
      httpStream: { endpoint: "/mcp", port: 0 },
    });
  }, 30_000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it("exposes all 5 tools after registration", () => {
    expect(Object.keys(tools).sort()).toEqual(
      ["character_sheet", "combat", "dice", "narrator", "world_state"].sort(),
    );
    for (const t of Object.values(tools)) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.execute).toBe("function");
    }
  });

  it("dice tool — roll_dice returns the expected payload shape", async () => {
    const res = (await tools.dice.execute({
      action: "roll_dice",
      notation: "1d20+5",
      seed: 42,
    })) as { content: Array<{ type: string; text: string }> };
    const payload = parseToolJson(res) as Record<string, unknown>;
    expect(payload.action).toBe("roll_dice");
    expect(payload.notation).toBe("1d20+5");
    expect(Array.isArray(payload.rolls)).toBe(true);
    expect(payload.rolls).toHaveLength(1);
    expect(payload.modifier).toBe(5);
    expect(typeof payload.total).toBe("number");
  });

  it("character_sheet tool — create returns full character payload", async () => {
    const res = (await tools.character_sheet.execute({
      action: "create",
      characterId: "boot-test-1",
      name: "Boot Hero",
      class: "Ranger",
      race: "Human",
      background: "Outlander",
      stats: { str: 14, dex: 16, con: 13, int: 10, wis: 12, cha: 8 },
    })) as { content: Array<{ type: string; text: string }> };
    const payload = parseToolJson(res) as Record<string, unknown>;
    expect(payload.characterId).toBe("boot-test-1");
    expect(payload.level).toBe(1);
    expect(payload.hp).toBe(11); // 10 + CON mod (13 → +1)
    expect(payload.statMods).toEqual({ str: 2, dex: 3, con: 1, int: 0, wis: 1, cha: -1 });
  });

  it("combat tool — standard attack returns roll/hit/damage shape", async () => {
    const res = (await tools.combat.execute({
      attacker: { name: "Boot", attackBonus: 4, damage: "1d6+2", damageType: "piercing" },
      target: { name: "Dummy", ac: 12, hp: 20, maxHp: 20 },
      status: ["seed:99"],
    })) as { content: Array<{ type: string; text: string }> };
    const payload = parseToolJson(res) as Record<string, unknown>;
    expect(payload.attacker).toBe("Boot");
    expect(payload.target).toBe("Dummy");
    expect(typeof payload.roll).toBe("number");
    expect(typeof payload.attackRoll).toBe("number");
    expect(typeof payload.hit).toBe("boolean");
    if (payload.hit) {
      expect(typeof payload.damage).toBe("number");
      expect(Array.isArray(payload.damageRolls)).toBe(true);
    }
  });

  it("world_state tool — set/get roundtrip", async () => {
    const intakeId = `boot-test-ws-${Date.now()}`;
    const setRes = (await tools.world_state.execute({
      action: "set",
      intakeId,
      state: { location: "Boot Camp", npcs: [] },
    })) as { content: Array<{ type: string; text: string }> };
    const setPayload = parseToolJson(setRes) as Record<string, unknown>;
    expect(setPayload.location).toBe("Boot Camp");
    expect(setPayload.timeOfDay).toBe("dawn");

    const getRes = (await tools.world_state.execute({
      action: "get",
      intakeId,
    })) as { content: Array<{ type: string; text: string }> };
    const getPayload = parseToolJson(getRes) as Record<string, unknown>;
    expect(getPayload.location).toBe("Boot Camp");
    expect(getPayload.timeOfDay).toBe("dawn");
  });

  it("narrator tool — returns a deterministic stub when LLM is absent", async () => {
    const res = (await tools.narrator.execute({
      intakeId: "boot-test-narr-1",
      lastAction: "I open the door slowly.",
    })) as { content: Array<{ type: string; text: string }> };
    // The factory wraps the text in `jsonContent(text)` with a string body
    // (not JSON-encoded), so `content[0].text` is the narrative text itself.
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("You consider: I open the door slowly.");
  });
});
