# Reference Uploads

> How a user-uploaded file (PDF, MD, JSON, image) becomes a runtime-readable reference
> inside a deployed gem, and how it gets garbage-collected 30 days later.

## Summary

Reference files are uploaded via `POST /api/refs` (multipart), staged in GCS at
`gs://ai-universe-lite-refs/tmp/<uploadId>/...`, then moved by Stage 1 INTAKE to
`gs://ai-universe-lite-refs/intake/<intakeId>/<filename>`. At runtime the gem fetches
them via `ctx.readTextRef("intake/<intakeId>/<filename>")` and they're deleted by a
30-day GCS lifecycle + a Cloud Scheduler cron job. The bucket is private (only the
gem-runtime SA can read); intake IDs are unguessable (nanoid 16 chars); signed URLs
expire in 7 days. Limits: 50 MB/file, 200 MB/intake, MIME whitelist.

## Table of Contents

- [1. The three flows](#1-the-three-flows)
- [2. Intake flow (upload)](#2-intake-flow-upload)
- [3. Retrieval flow (runtime)](#3-retrieval-flow-runtime)
- [4. GC flow (lifecycle + cron)](#4-gc-flow-lifecycle--cron)
- [5. Limits](#5-limits)
- [6. Security](#6-security)
- [7. Failure modes](#7-failure-modes)
- [8. Bundle mode (system prompt injection)](#8-bundle-mode-system-prompt-injection)
- [9. Future (Phase 2+)](#9-future-phase-2)
- [See also](#see-also)

## 1. The three flows

A reference file has a lifecycle with three independent flows:

```
┌────────────┐      ┌────────────┐      ┌────────────┐
│  INTAKE    │      │ RETRIEVAL  │      │    GC      │
│ (upload)   │      │ (runtime)  │      │ (cleanup)  │
└────────────┘      └────────────┘      └────────────┘
     │                   │                   │
     ▼                   ▼                   ▼
POST /api/refs    ctx.readTextRef()    30d lifecycle +
  multipart         (gem runtime)       /api/cron/ref-gc
     │                   │                   │
     ▼                   ▼                   ▼
GCS tmp/...         GCS intake/...      GCS delete
     │                   │
     │  Stage 1 INTAKE   │
     │  moves tmp→intake │
     └───────────────────┘
```

The **intake** flow is what happens when a user runs `/gem-create "..." --ref file.pdf`.
The **retrieval** flow is what happens when the deployed gem, 14 days later, calls
`ctx.readTextRef("intake/<intakeId>/file.pdf")` in response to a user query. The **GC**
flow is what cleans the file up 30 days after upload.

## 2. Intake flow (upload)

### 2.1 User side

```bash
# Via the gem-create skill (slash command)
/gem-create "RPG game" --ref ./rulebook.pdf --bundle

# Via the local CLI
./scripts/create-gem.sh "RPG game" --ref ./rulebook.pdf

# Via the HTTP API directly
curl -X POST https://api.ai-universe.app/api/refs \
  -F "file=@./rulebook.pdf"
```

### 2.2 What the backend does

1. **Auth:** the request must carry a Firebase ID token (Bearer header). The backend
   resolves it to an `authorUid`.
2. **MIME detection:** the file is sniffed (via the `file-type` npm package — checks
   magic bytes, not the `Content-Type` header). The detected MIME must be on the
   whitelist (see §5).
3. **Size check:** file must be ≤ 50 MB. Cumulative intake size is checked later
   (200 MB cap; see §5).
4. **Upload to GCS:** the file is streamed to
   `gs://ai-universe-lite-refs/tmp/<uploadId>/<filename>` where `<uploadId>` is a
   fresh `nanoid(16)` (unguessable; collisions practically impossible at our scale).
   The `tmp/` prefix is intentionally separate from `intake/` — files in `tmp/` are
   not yet attached to a gem and will be GC'd after 24 h if not promoted.
5. **Signed URL response:** the backend returns a **7-day signed URL** (V4 signing,
   `Content-Type` and `Content-Disposition` headers included) that the client can use
   to download the file directly from GCS. The client does **not** need this for
   `/gem-create` (the backend already has the GCS path); the signed URL is for the
   client-side preview and the share-URL preview.

### 2.3 What Stage 1 INTAKE does

When the user submits `/gem-create "..." --ref ./rulebook.pdf`, the backend's
`scripts/create-gem.sh` (or `/gem-create` skill) does:

1. Upload the file to `gs://ai-universe-lite-refs/tmp/<uploadId>/rulebook.pdf`
2. Call `POST /api/gems` with `{ prompt, refPaths: ["tmp/<uploadId>/rulebook.pdf"], ... }`
3. Stage 1 INTAKE (deterministic) moves the file from
   `gs://ai-universe-lite-refs/tmp/<uploadId>/rulebook.pdf` to
   `gs://ai-universe-lite-refs/intake/<intakeId>/rulebook.pdf`
4. Stage 1 records the new `gcsRefPrefix = "intake/<intakeId>/"` in
   `gem_intakes/<intakeId>`

The `tmp/` to `intake/` move is a GCS `rewrite` (server-side copy + delete) — it does
not download the bytes to the backend. The file is then permanently attached to the
gem and lives for 30 days from the **upload** timestamp (not the move timestamp).

### 2.4 API summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/refs` | multipart | Upload a file; returns `uploadId` + 7-day signed URL |
| `GET /api/refs/<uploadId>/<filename>` | GET (via signed URL) | Download the uploaded file |
| `POST /api/gems` | JSON | Create a gem; `refPaths: ["tmp/<uploadId>/<filename>"]` |

## 3. Retrieval flow (runtime)

### 3.1 The gem-runtime contract

Every deployed gem has `ctx.readTextRef(gcsPath: string)` available on its
`GemContext`. The path is the **full GCS object path** (e.g.
`intake/intk_a1b2c3d4.../rulebook.pdf`).

```ts
// gems/ai-rpg/src/tools/summarize_rule.ts
const summarizeRule: ToolFactory = (ctx) => ({
  name: "summarize_rule",
  description: "Summarize a section of the rulebook reference.",
  parameters: z.object({
    section: z.string().min(1).max(80),
  }),
  execute: async ({ section }) => {
    // Read the uploaded rulebook (text-extracted by the runtime)
    const text = await ctx.readTextRef("intake/intk_a1b2c3.../rulebook.pdf");
    // ... call LLM with section + text ...
  },
});
```

### 3.2 What the runtime does

`ctx.readTextRef(path)` (in `@ai-universe/gem-runtime`) is a thin wrapper around the
GCS SDK call:

1. **Auth:** the gem-runtime service account
   (`ai-universe-lite-gem-runtime@ai-universe-2025.iam.gserviceaccount.com`) is
   bound to `roles/storage.objectViewer` on the `ai-universe-lite-refs` bucket.
   The gem's Cloud Run service uses this SA; the call succeeds.
2. **Fetch:** GCS `objects.get` for the path.
3. **Text extraction:** depending on the MIME, the runtime extracts text:
   - `text/*` and `application/json` and `application/yaml` — return as-is.
   - `application/pdf` — `pdf-parse` (pure JS, no external deps).
   - `image/png`, `image/jpeg`, `image/webp` — Tesseract OCR (lazy-loaded; not in
     the cold-start path).
4. **Returns:** the extracted text as a single `string`. The gem is responsible for
   truncating it (typical max: 32k tokens) before passing to the LLM.

### 3.3 What the runtime does NOT do

- It does **not** return the raw bytes (no base64 PDFs flying around the gem's logs).
- It does **not** do chunking or embedding — that's the gem's job. The runtime hands
  you a string; you decide how to use it.
- It does **not** cache. Each `readTextRef` is a GCS round-trip. If a gem needs
  caching, it should cache in its own in-memory map (gems are stateless on disk by
  default).

## 4. GC flow (lifecycle + cron)

### 4.1 The 30-day GCS lifecycle

The bucket is defined in `infra/terraform/gcs.tf` (deployed in the `phase-1-terraform`
PR) with a lifecycle rule:

```hcl
resource "google_storage_bucket" "refs" {
  name     = "ai-universe-lite-refs"
  location = "us-central1"
  uniform_bucket_level_access = true
  versioning { enabled = true }
  lifecycle_rule {
    condition { age = 30 }      # delete anything older than 30 days
    action { type = "Delete" }
  }
}
```

The `age=30` is measured from the object's `timeCreated` (i.e. upload time). The
`intake/` prefix is not exempt — refs are deleted 30 days after upload regardless of
whether the gem is still live. This is intentional: the gem is expected to have
cached or internalized anything it needed in the first few days; the GCS copy is a
bootstrapping convenience, not a permanent store.

The `tmp/` prefix has its own, more aggressive lifecycle (24h) so abandoned uploads
don't pile up.

### 4.2 The Cloud Scheduler cron job

For gems that were **soft-deleted** (`status="deleted"` on the `GemRegistryEntry`),
the lifecycle is too slow — 30 days is a long time to leave a soft-deleted gem's refs
in GCS. The cleanup is accelerated by a Cloud Scheduler cron job:

- **Schedule:** `0 3 * * *` (3 AM daily)
- **Target:** `POST https://api.ai-universe.app/api/cron/ref-gc`
- **Auth:** OIDC token from the Cloud Scheduler SA
- **Behavior:** the handler (`backend/src/server.ts → /api/cron/ref-gc`)
  1. Lists all `gems/<gemId>` with `status="deleted"`.
  2. For each, finds the matching `gcsRefPrefix = "intake/<intakeId>/"` (via the
     `intakeId` field on the `GemRegistryEntry`).
  3. Deletes every object under that prefix.
  4. Appends `{ type: "refs.gc", gemId, intakeId, deletedCount, ts }` to
     `gem_audit_log`.

The cron job is **idempotent** — re-running on an already-cleaned gem is a no-op
(GCS `objects.delete` returns 404, which the handler logs as `info` not `error`).

### 4.3 The full GC stack

```
30 days
   │
   ▼
┌────────────────────┐
│ GCS lifecycle rule │  hard-delete every object
│ (age = 30)         │  regardless of gem status
└────────────────────┘
   ▲
   │  ALSO accelerated by:
   │
┌────────────────────┐
│ Cloud Scheduler    │  daily 3 AM: delete refs for
│ ref-gc cron        │  status="deleted" gems
└────────────────────┘
```

The lifecycle is the **floor** (no gem's refs live past 30 days). The cron is the
**accelerator** (soft-deleted gems lose their refs within 24 h).

## 5. Limits

| Field | Value | Where enforced | Notes |
|-------|-------|----------------|-------|
| Max file size | **50 MB** | `POST /api/refs` | Rejected with HTTP 413 `file_too_large` |
| Max files per intake | 20 | `POST /api/refs` (cumulative) | Rejected with HTTP 413 `too_many_files` |
| Max total per intake | **200 MB** | `POST /api/refs` (cumulative size) | Rejected with HTTP 413 `intake_too_large` |
| MIME whitelist | `text/*`, `application/pdf`, `application/json`, `application/yaml`, `application/x-yaml`, `image/png`, `image/jpeg`, `image/webp` | magic-byte sniff + extension | Rejected with HTTP 415 `mime_not_allowed` |
| Disallowed | binaries (executables, archives, anything not on the whitelist) | same | |
| Signed URL TTL | **7 days** | `POST /api/refs` response | V4 signed URL, read-only |
| GCS `tmp/` lifetime | 24 h | GCS lifecycle | Abandoned uploads self-clean |
| GCS `intake/` lifetime | **30 days** | GCS lifecycle | Hard floor |
| Per-gem ref fetch latency | p95 < 200 ms (warm) | `ctx.readTextRef` | Cold path: first fetch of a session; warm: in-memory LRU in the runtime |
| OCR latency | p95 < 4 s for a single A4 page | Tesseract | First image OCR is slow; subsequent calls hit the runtime LRU |

**Why 50 MB / 200 MB:** the upstream Cloud Run request body limit is 32 MB (per
single request), so we use the GCS resumable upload protocol to bypass that for the
50 MB cap. 200 MB per intake is a soft cap based on "this is what fits in a single
LLM context after text extraction" — anything bigger won't be readable at runtime
even if it uploads.

## 6. Security

### 6.1 Intake IDs are unguessable

`intakeId` is generated as `intk_<16>` where the 16 chars are a custom alphabet
(`a-z0-9`, no look-alikes removed — but 36^16 ≈ 8 × 10^24 entropy is more than
enough). The 12-char `uploadId` is `run_<12>` (same alphabet, 36^12 ≈ 4 × 10^18
entropy). Even with the full alphabet, brute-forcing a single intake is not
tractable.

```ts
// backend/src/lib/crypto.ts
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const intakeIdGen = customAlphabet(ALPHABET, 16);
const runIdGen = customAlphabet(ALPHABET, 12);
export const newIntakeId = (): string => `intk_${intakeIdGen()}`;
```

### 6.2 Signed URLs expire in 7 days

`POST /api/refs` returns a V4 signed URL with a 7-day TTL. After 7 days, the URL
returns 403 (the signature no longer validates). This is enough for the client to
preview the file, share it with collaborators, and pass it through the gem-create
flow — but not so long that a leaked URL is a permanent backdoor.

### 6.3 GCS bucket is private

The `ai-universe-lite-refs` bucket is configured with `uniform_bucket_level_access = true`
and **no** `allUsers` or `allAuthenticatedUsers` IAM bindings. The only readers are:

- The **gem-runtime service account** (`ai-universe-lite-gem-runtime@...`) — has
  `roles/storage.objectViewer`, used by deployed gems via `ctx.readTextRef`.
- The **backend service account** — has `roles/storage.objectAdmin`, used by
  `POST /api/refs`, Stage 1 INTAKE (move `tmp→intake`), and the ref-gc cron.
- **Project owners** — implicit, for emergency access.

There is no public read access under any circumstance. The signed URLs are scoped
per-object and time-limited; they do not grant bucket-wide access.

### 6.4 Input validation

- The MIME check uses **magic bytes** (the `file-type` package), not the
  `Content-Type` header. A user renaming `evil.exe` to `evil.pdf` gets
  `mime_not_allowed`.
- The size check is enforced **at the request level** (via `content-length` header
  inspection) **and** at the GCS resumable upload finalize step. A user lying about
  the content-length gets the upload aborted at the first byte.

### 6.5 Per-intake isolation

Two different intakes cannot read each other's refs, even if they guess the
`intakeId`. The bucket is flat (no folder-level IAM), but the `intakeId` is
unguessable, and the only way to get a read handle is to be the gem that was built
from that intake (the gem-runtime SA reads via the path, and the path is supplied
to the gem at boot via the `REF_BUCKET` env var + the `intakeId` from the
`GemRegistryEntry`).

## 7. Failure modes

| Failure | What happens | User impact | Recovery |
|---------|--------------|-------------|----------|
| GCS write fails (network, 503 from GCS) | `POST /api/refs` returns 502 `gcs_write_failed` | Upload aborts client-side | User retries |
| File exceeds 50 MB | `POST /api/refs` returns 413 `file_too_large` | Reject before upload starts | User splits the file |
| MIME not on whitelist | `POST /api/refs` returns 415 `mime_not_allowed` | Reject | User converts (e.g. PDF → text) |
| GCS move `tmp→intake` fails in Stage 1 INTAKE | Stage 1 returns 503 `intake_persist_failed`; the `tmp/` object is **left in place** for the 24h lifecycle to clean | Gem creation aborts; user can retry with the same file | Stage 1 retries once; if still failing, the `tmp/` is auto-cleaned within 24h |
| The gem tries to read a deleted ref (GC'd) | `ctx.readTextRef` throws `GcsObjectNotFound`; the gem's tool returns a friendly "this ref is no longer available" message | Tool output is helpful, not a 500 | User re-uploads (in Phase 2: ref re-upload via share token) |
| Signed URL is expired (user tries to download a 14-day-old upload) | GCS returns 403 `SignatureDoesNotMatch` | Download fails | Re-issue a fresh signed URL (admin tool) |
| Bucket is briefly unavailable (GCS regional outage) | All `ctx.readTextRef` calls throw 503; gems return "ref temporarily unavailable" | Tool output is helpful, not a 500 | Auto-recovers when GCS recovers |
| Cron job fails partway through | The job is idempotent; the next day's run picks up any un-deleted soft-deleted gem refs | GC is delayed by 24h | Self-heals on next run |

## 8. Bundle mode (system prompt injection)

If the user adds `--bundle` to `/gem-create`, the runtime concatenates all text refs
into a "system prompt bundle" and prepends it to the gem's `systemPrompt` field.

```ts
// In the gem-runtime, when bundleRefs: true
const bundle = refs.map((r) => readText(r)).join("\n\n---\n\n");
ctx.systemPrompt = `[REF BUNDLE]\n\n${bundle}\n\n[ORIGINAL]\n\n${GEM_SYSTEM_PROMPT}`;
```

This is what makes "use this RPG rulebook" a one-flag operation. The gem's
`GEM_SYSTEM_PROMPT` (in `src/system-prompt.ts`) becomes the **tail** of the runtime
prompt, and the bundle is prepended. See
[`docs/gem-authoring.md` §5](./gem-authoring.md#5-reference-authority-the-bundle-contract)
for the system-prompt side of this contract.

The same pattern is used by `ai_universe`'s `mvp_site` system.

## 9. Future (Phase 2+)

- **Per-ref public URL** (signed, 1h TTL) for embedding in a gem's output (e.g. the
  gem can return a "view the original PDF" link that the frontend can render).
- **Ref re-upload via share token** — the gem author can update the bundle after
  publish, without re-running the full pipeline.
- **Ref deduplication** (content-hash key) — same file uploaded twice doesn't burn
  2× the storage.
- **Per-intake ref retention override** — gems with `visibility="public"` can opt
  into a longer (90d) retention via a flag in the `GemSpec`.

## See also

- [`docs/gem-builder.md`](./gem-builder.md) — the 8-stage pipeline; Stage 1 INTAKE
  is the only stage that moves refs from `tmp/` to `intake/`.
- [`docs/gem-authoring.md`](./gem-authoring.md) — `ctx.readTextRef` is the runtime
  contract for reading refs; the system-prompt §5 explains `--bundle`.
- [`docs/cross-repo-hooks.md`](./cross-repo-hooks.md) — the audit log is shared
  between refs GC and registry hooks.
- [`infra/terraform/gcs.tf`](../infra/terraform/gcs.tf) — bucket definition + 30-day
  lifecycle (delivered in the `phase-1-terraform` PR)
- [`backend/src/server.ts`](../backend/src/server.ts) — `/api/cron/ref-gc` endpoint
  (delivered in the `phase-1-backend` PR)
- [`AGENTS.md`](../AGENTS.md) — repo-level security guidelines
