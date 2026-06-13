# Reference Uploads

When a user creates a gem with `--ref <file>`, the file becomes a gem resource.

## Upload Path

```
Local:  ./my-doc.pdf
   │
   │  POST /api/refs (multipart/form-data)
   ▼
GCS:    gs://ai-universe-lite-refs/tmp/<uploadId>/my-doc.pdf
   │
   │  Stage 1 INTAKE moves to:
   ▼
GCS:    gs://ai-universe-lite-refs/intake/<intakeId>/my-doc.pdf
```

## Limits

| Field | Value |
|-------|-------|
| Max file size | 50 MB |
| Max total per gem | 200 MB |
| Max files per gem | 20 |
| MIME whitelist | `text/*`, `application/pdf`, `application/json`, `application/yaml`, `application/x-yaml`, `image/png`, `image/jpeg`, `image/webp` |
| Disallowed | binaries, archives, executables, anything not on the whitelist |

## How the Gem Loads Refs

In the gem's `src/server.ts`:

```ts
import { loadGemContext } from "@ai-universe/gem-runtime";

const ctx = loadGemContext({
  gemId: config.gemId,
  gemVersion: config.gemVersion,
  systemPrompt: GEM_SYSTEM_PROMPT,
});

// ctx.refs is a Map<filename, RefEntry>
for (const [filename, ref] of ctx.refs) {
  console.log(`${filename}: ${ref.gcsPath} (${ref.mimeType}, ${ref.sizeBytes} bytes)`);
}

// Read a ref's contents (text-only)
const text = await ctx.readTextRef("my-doc.pdf");
```

The `gem-runtime` package handles the GCS fetch, MIME detection, and text extraction (PDFs go through `pdf-parse`, images through OCR if needed, JSON/YAML parsed directly).

## Bundle Mode (System Prompt Injection)

If the user adds `--bundle`, the runtime concatenates all text refs into a "system prompt bundle" and prepends it to the gem's `systemPrompt` field. This is what makes "use this RPG rulebook" a one-flag operation.

```ts
const ctx = loadGemContext({ ..., bundleRefs: true });
// ctx.systemPrompt = "[REF BUNDLE]\n\n" + refs.map(readText).join("\n\n---\n\n") + "\n\n[ORIGINAL]\n\n" + GEM_SYSTEM_PROMPT
```

The same pattern is used by `ai_universe`'s `mvp_site` system.

## Soft-Delete on Gem Delete

When a gem is deleted (soft or hard), refs are kept for 30 days, then a Cloud Scheduler job (`scripts/gc-refs.sh`, Phase 1) deletes any `gs://ai-universe-lite-refs/intake/<intakeId>/*` older than 30 days where the corresponding `gem_runs/<runId>` has `status="deleted"`.

## Future (Phase 2)

- Per-ref public URL (signed, 1h TTL) for embedding in a gem's output.
- Ref re-upload via share token (gem author can update the bundle after publish).
- Ref deduplication (content-hash key).
