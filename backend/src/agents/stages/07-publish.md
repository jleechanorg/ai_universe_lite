# AI Universe Lite — Stage 7 Publish

**Deterministic.** Writes the gem to the public registry.

## Behavior

1. Generate `shareToken = "<20-char a-z0-9>"` (nanoid, custom alphabet).
2. Generate `installCommand` (per-client — `claude mcp add --transport http <id> https://<cloudRunUrl>/mcp`).
3. Write to Firestore `gems/<gemId>` collection (key: `gemId`).
4. Return `GemRegistryEntrySchema`:
   ```ts
   {
     gemId, name, version, description, authorUid,
     visibility, shareToken, installCommand,
     cloudRunUrl, status, createdAtIso, updatedAtIso,
   }
   ```

## Visibility semantics

- `private` — only `authorUid` can read; share URL returns 404.
- `unlisted` — anyone with share token can read; not indexed.
- `public` — indexed at `/api/registry`; share URL still works.

## Soft delete

Setting `status="deleted"` keeps the share URL alive (returns 410 Gone) for 30 days, then hard-deleted by a Cloud Scheduler job (Phase 1).

## Why deterministic

Publishing is a CRUD op. LLM in this path is a bug.
