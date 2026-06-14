/**
 * references.ts — load intake-scoped reference files for a given intakeId.
 *
 * Reference files are uploaded to `gs://ai-universe-lite-refs/intake/<intakeId>/*`
 * via the gem-builder pipeline. The runtime exposes them on `ctx.refs`
 * keyed by filename, and `ctx.readTextRef` fetches the text payload.
 */

import type { GemContext } from "@ai-universe/gem-runtime";

const INTAKE_PREFIX = "intake/";

function buildIntakePrefix(intakeId: string): string {
  return `${INTAKE_PREFIX}${intakeId}/`;
}

export async function loadIntakeRefs(
  ctx: GemContext,
  intakeId: string,
): Promise<Record<string, string>> {
  if (!intakeId) {
    return {};
  }

  const prefix = buildIntakePrefix(intakeId);
  const result: Record<string, string> = {};
  const entries = Array.from(ctx.refs.entries());

  for (const [filename, ref] of entries) {
    if (!ref || !ref.gcsPath) {
      continue;
    }
    if (!ref.gcsPath.startsWith(prefix)) {
      continue;
    }
    try {
      const text = await ctx.readTextRef(filename);
      if (text) {
        result[filename] = text;
      }
    } catch {
      // Skip unreadable refs — tools should be resilient to missing files.
    }
  }

  return result;
}
