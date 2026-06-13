# AI Universe Lite — Stage 1 Intake

Normalizes a user prompt + uploaded refs into a stable, persisted intake record.

## Inputs

```ts
{
  prompt: string (8..8000 chars),
  refPaths: string[] (0..N GCS paths),
  authorUid: string,
  visibility: "private" | "unlisted" | "public",
}
```

## Behavior

1. Validate via `IntakeInputSchema` (`src/lib/schema.ts`).
2. Generate `intakeId = "intk_<16>"`.
3. Compute `gcsRefPrefix = "intake/<intakeId>/"`.
4. Move ref uploads (already in `gs://ai-universe-lite-refs/tmp/<uploadId>/...`) to the intake prefix.
5. Persist `IntakeOutput` to Firestore collection `gem_intakes`.
6. Return `intakeId` + `gcsRefPrefix`.

## What it does NOT do

- Does not invoke any LLM (deterministic).
- Does not generate the gem spec (Stage 3).
- Does not talk to GitHub or Cloud Run.

## Failure modes

- Ref upload missing from GCS → `HttpError(400, "ref_not_found")`.
- Author uid invalid → `HttpError(401, "invalid_author")`.
- Firestore write failure → retry once, then `HttpError(503, "intake_persist_failed")`.
