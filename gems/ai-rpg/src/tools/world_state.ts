// world_state.ts — per-intake world state singleton (in-memory).
//
// One `Map<intakeId, WorldState>` lives at module scope. The state tracks the
// party's current location, an NPC list (name / role / disposition), and a
// deterministic time-of-day cycle that advances on `advance_time`.
//
// Time-of-day cycle (7 stages, repeating):
//   dawn -> morning -> noon -> afternoon -> evening -> night -> midnight -> dawn
//
// In production this would be backed by Firestore / a session store; for the
// v1 gem it's an in-process map that resets on server restart.

import { z } from "zod";
import type { ToolFactory } from "@ai-universe/gem-runtime";

const NpcSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  disposition: z.string().min(1),
});

const StateSchema = z.object({
  location: z.string().min(1),
  npcs: z.array(NpcSchema).default([]),
});

const InputSchema = z.object({
  action: z.enum(["get", "set", "add_npc", "advance_time"]),
  intakeId: z.string().min(1),
  state: StateSchema.optional(),
  npc: NpcSchema.optional(),
});

type WorldState = z.infer<typeof StateSchema> & {
  intakeId: string;
  timeOfDay: TimeOfDay;
  updatedAt: string;
};

const TIME_CYCLE = [
  "dawn",
  "morning",
  "noon",
  "afternoon",
  "evening",
  "night",
  "midnight",
] as const;
type TimeOfDay = (typeof TIME_CYCLE)[number];

const DEFAULT_TIME: TimeOfDay = "dawn";

const stateStore = new Map<string, WorldState>();

function nowIso(): string {
  return new Date().toISOString();
}

function getOrInit(intakeId: string): WorldState {
  const existing = stateStore.get(intakeId);
  if (existing) return existing;
  const fresh: WorldState = {
    intakeId,
    location: "Unknown",
    npcs: [],
    timeOfDay: DEFAULT_TIME,
    updatedAt: nowIso(),
  };
  stateStore.set(intakeId, fresh);
  return fresh;
}

function advance(t: TimeOfDay): TimeOfDay {
  const i = TIME_CYCLE.indexOf(t);
  if (i < 0) return DEFAULT_TIME;
  return TIME_CYCLE[(i + 1) % TIME_CYCLE.length] as TimeOfDay;
}

function jsonContent(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const worldStateTool: ToolFactory = () => ({
  name: "world_state",
  description:
    "Per-intake world state. get/set the location + NPC list, add_npc to the current scene, or advance_time (cycles dawn -> morning -> noon -> afternoon -> evening -> night -> midnight -> dawn). State is held in memory at module scope.",
  parameters: InputSchema,
  execute: async (params: z.infer<typeof InputSchema>) => {
    const { action, intakeId } = params;

    if (action === "get") {
      const s = getOrInit(intakeId);
      return jsonContent({ ...s });
    }

    if (action === "set") {
      if (!params.state) {
        return jsonContent({ error: "state_required" });
      }
      const existing = getOrInit(intakeId);
      const next: WorldState = {
        ...existing,
        ...params.state,
        intakeId,
        updatedAt: nowIso(),
      };
      stateStore.set(intakeId, next);
      return jsonContent({ ...next });
    }

    if (action === "add_npc") {
      if (!params.npc) {
        return jsonContent({ error: "npc_required" });
      }
      const existing = getOrInit(intakeId);
      const next: WorldState = {
        ...existing,
        npcs: [...existing.npcs, params.npc],
        updatedAt: nowIso(),
      };
      stateStore.set(intakeId, next);
      return jsonContent({ ...next });
    }

    // advance_time
    const existing = getOrInit(intakeId);
    const next: WorldState = {
      ...existing,
      timeOfDay: advance(existing.timeOfDay),
      updatedAt: nowIso(),
    };
    stateStore.set(intakeId, next);
    return jsonContent({ ...next });
  },
});

export default worldStateTool;
