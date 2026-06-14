# ai-rpg gem

A D&D 5e-flavored tabletop RPG co-GM delivered as a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server. The gem exposes five structured tools — `character_sheet`, `dice`, `combat`, `world_state`, and `narrator` — that any MCP-capable client (Claude Code, Codex, Claude Desktop, custom agents) can call to run a session deterministically. State is per-intake and held in memory at module scope; the LLM is invoked only for the optional 1-paragraph backstory on `character_sheet.create` and for the 2-3 sentence `narrator` beat.

This is the v1 reference gem for the AI Universe Lite pipeline. It is intentionally minimal so the gem-builder can clone the structure for new gems.

## Install

The gem ships as an MCP server you run with `npx` (or via Cloud Run — see `deploy.sh`). Local dev:

```bash
cd gems/ai-rpg
npm install
npm run build
PORT=8080 node dist/src/server.js    # MCP endpoint at http://localhost:8080/mcp
```

To register with Claude Code:

```bash
claude mcp add ai-rpg --transport http --url http://localhost:8080/mcp
```

Or pin to a deployed env:

```bash
claude mcp add ai-rpg --transport http --url https://gem-ai-rpg-dev-ai-universe-2025.a.run.app/mcp
```

## MCP tool catalog

All five tools return `{ content: [{ type: "text", text: <json or string> }] }` per the MCP spec. Examples below use `parseToolJson` to extract the JSON payload.

### `character_sheet` — D&D 5e character CRUD

Create / read / update / level up a character. HP is auto-computed from CON; L1 HP = 10 + CON mod, level-up HP gain = 5 + CON mod.

```jsonc
// Input
{
  "action": "create",
  "characterId": "aria-1",
  "name": "Aria the Bold",
  "class": "Ranger",
  "race": "Half-Elf",
  "background": "Outlander",
  "stats": { "str": 16, "dex": 14, "con": 13, "int": 12, "wis": 15, "cha": 10 }
}

// Output
{
  "characterId": "aria-1",
  "name": "Aria the Bold",
  "class": "Ranger",
  "race": "Half-Elf",
  "background": "Outlander",
  "level": 1,
  "stats": { "str": 16, "dex": 14, "con": 13, "int": 12, "wis": 15, "cha": 10 },
  "statMods": { "str": 3, "dex": 2, "con": 1, "int": 1, "wis": 2, "cha": 0 },
  "hp": 11,        // 10 + CON mod
  "maxHp": 11
}
```

### `dice` — deterministic dice rolling

`roll_dice` parses standard notation (`NdM` optionally followed by `+K` or `-K`); `roll_stat` returns six 3d6-drop-lowest stats; `roll_d100` returns 1-100. Pass `seed` for reproducible output.

```jsonc
// Input
{ "action": "roll_dice", "notation": "2d10+3", "seed": 42 }

// Output
{
  "action": "roll_dice",
  "notation": "2d10+3",
  "rolls": [7, 4],
  "sum": 11,
  "modifier": 3,
  "total": 14,
  "seed": 42
}
```

### `combat` — D&D 5e attack resolution

Rolls d20 + attackBonus vs AC. Natural 20 = auto-hit + crit (doubles damage dice). Natural 1 = auto-miss. Advantage / disadvantage supported. At 0 HP the target is marked `dead: true` and `deathSave: true`.

```jsonc
// Input
{
  "attacker": { "name": "Aria", "attackBonus": 5, "damage": "1d8+3", "damageType": "slashing" },
  "target":    { "name": "Goblin", "ac": 14, "hp": 20, "maxHp": 20 },
  "advantage": true,
  "status": ["seed:7"]
}

// Output (on hit)
{
  "roll": 17,
  "attackRoll": 22,             // 17 + 5
  "ac": 14,
  "hit": true,
  "damage": 9,
  "damageRolls": [6],
  "damageModifier": 3,
  "damageType": "slashing",
  "attacker": "Aria",
  "target": "Goblin",
  "targetHp": 11,               // 20 - 9
  "targetMaxHp": 20,
  "dead": false,
  "deathSave": false,
  "advDisRolls": [12, 17]       // took the higher of the two
}
```

### `world_state` — per-intake world state

One world per `intakeId`. Tracks `location`, an `npcs` list (name / role / disposition), and a deterministic time-of-day cycle. `advance_time` cycles dawn → morning → noon → afternoon → evening → night → midnight → dawn (7 stages, then wraps).

```jsonc
// Input
{
  "action": "add_npc",
  "intakeId": "campaign-001",
  "npc": { "name": "Brom Ironbeard", "role": "blacksmith", "disposition": "friendly" }
}

// Output
{
  "intakeId": "campaign-001",
  "location": "Riverdell Tavern",
  "npcs": [{ "name": "Brom Ironbeard", "role": "blacksmith", "disposition": "friendly" }],
  "timeOfDay": "dawn",
  "updatedAt": "2026-06-13T17:00:00.000Z"
}
```

### `narrator` — narrative beat for the last action

Composes a 2-3 sentence GM-voice narration conditioned on the gem's system prompt, the intake's reference files, and the current world state. When no LLM is wired up, returns a deterministic stub: `"You consider: <lastAction>"`.

```jsonc
// Input
{
  "intakeId": "campaign-001",
  "lastAction": "I swing my sword at the goblin.",
  "worldStateContext": "Riverdell Tavern, dawn, 1 NPC: Brom (friendly)"
}

// Output (with LLM configured)
// { "content": [{ "type": "text", "text": "Aria's blade arcs through the dawn light, biting into the goblin's guard. Brom looks up from the forge, eyes wide — and not with fear alone." }] }

// Output (no LLM — deterministic stub)
{ "content": [{ "type": "text", "text": "You consider: I swing my sword at the goblin." }] }
```

## Sample prompts

Once the gem is registered with an MCP client, these prompts will trigger the right tool calls:

1. **Create a level-1 character:** *"Create a half-elf ranger named Aria with these stats: STR 16, DEX 14, CON 13, INT 12, WIS 15, CHA 10. Background: Outlander."*
2. **Roll initiative for the party:** *"Roll 1d20+2 for Aria, 1d20+1 for Borrik, and 1d20+4 for the goblin. Use seed 42 so I can reproduce it."*
3. **Resolve an attack with advantage:** *"Aria attacks the goblin with advantage and a +5 attack bonus using her longbow (1d8+3 slashing). Goblin has AC 14 and 20 HP."*

## Development

```bash
npm install
npm run type-check   # tsc --noEmit
npm run lint         # eslint
npm test             # jest (43 tests across 5 files)
npm run build        # tsc → dist/
```

## Deploy

`deploy.sh` mirrors `templates/deploy.gem.sh.tmpl` and the contract in `docs/cloudrun-deploy.md`. Prod deploys are blocked locally; use the `gem-publish.yml` GitHub Actions workflow with manual approval.

```bash
# Dev / staging — works locally
./deploy.sh dev

# Prod — blocked unless ALLOW_LOCAL_PROD_DEPLOY=true or running in CI
./deploy.sh prod
```
