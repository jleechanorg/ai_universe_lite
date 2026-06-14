# Cross-Repo Hooks

> What the Stage 8 Registry Hooks stage does to the *other* repos in the AI Universe constellation, how it soft-fails, and how to roll back.

## Summary

After a gem is published, Stage 8 opens PRs in two sibling repos
(`ai_universe_frontend` and `ai_universe_landing`) to register the new gem's share URL
and embed config. A failed PR **does not** unpublish the gem — the gem is live, the
embed route just appears 1-2 days late. Rollback is a two-step manual operation:
revert the PR and patch the gem's `cloudRunUrl` in Firestore. A `rollback-gem.yml`
GitHub Actions workflow exists for the common case.

## Table of Contents

- [1. What Stage 8 actually does](#1-what-stage-8-actually-does)
- [2. The two cross-repo PRs](#2-the-two-cross-repo-prs)
- [3. Branch + file shape](#3-branch--file-shape)
- [4. Soft-fail behavior](#4-soft-fail-behavior)
- [5. Audit log entries](#5-audit-log-entries)
- [6. How to roll back](#6-how-to-roll-back)
- [7. Manual override: `rollback-gem.yml`](#7-manual-override-rollback-gemyml)
- [See also](#see-also)

## 1. What Stage 8 actually does

`backend/src/agents/stages/08-registry-hooks.ts` is invoked at the end of every
successful pipeline run, after Stage 7.5 has set `cloudRunUrl` and `status="live"` on
the `GemRegistryEntry`. It performs **four** actions, in order:

1. **Frontend embed PR** — opens a PR in `jleechanorg/ai_universe_frontend` that
   registers the gem's share URL route + `<GemEmbed>` config block.
2. **Landing page PR** — opens a PR in `jleechanorg/ai_universe_landing` (if the
   gem's `visibility="public"`) that adds a card to the public registry page.
3. **Slack announcement** — posts a one-line "new gem available" message to
   `#ai-universe-gems` (only if `visibility="public"`).
4. **Final audit log row** — appends `{ type: "gem.live", runId, gemId, cloudRunUrl, ts }`
   to `gem_audit_log`.

All four are deterministic (no LLM). All four write audit log rows. **None of them is
required for the gem to be considered live** — that decision is made at Stage 7.5.

The full stage source is at `backend/src/agents/stages/08-registry-hooks.ts` and the
stage-level doc is at
[`backend/src/agents/stages/08-registry-hooks.md`](../backend/src/agents/stages/08-registry-hooks.md).

## 2. The two cross-repo PRs

### 2.1 Frontend PR — `jleechanorg/ai_universe_frontend`

**Why:** the frontend is what serves the share URL at `https://ai-universe.app/gems/<shareToken>`.
Without this PR, the share URL renders a 404.

**What it does:**

- Registers a new route in the frontend router for the gem's `gemId` (so the
  `/gems/<shareToken>` page can render the right embed).
- Adds an entry to the `<GemEmbed>` registry (a static config block in the frontend
  repo) describing the gem's iframe mount point, allowed `postMessage` origins, and
  visual theme.

**When it runs:** always, for every successfully published gem (regardless of
visibility).

### 2.2 Landing-page PR — `jleechanorg/ai_universe_landing`

**Why:** the landing page at `https://ai-universe.app/` shows a public gallery of gems.
Private and unlisted gems are not added; only `visibility="public"` ones are.

**What it does:**

- Adds a card to the public registry grid with the gem's name, description, and
  install command.
- Generates a static OG image (via the same OG-image pipeline the rest of the
  landing page uses).

**When it runs:** only if `visibility="public"`.

## 3. Branch + file shape

Both PRs follow a fixed convention. The branch name is deterministic and predictable
(so reviewers can grep for stale hooks that never merged).

### 3.1 Branch name

```
gem-hooks/<gemId>-<shortRunId>
```

For example, for the `ai-rpg` gem from `run_a1b2c3d4e5f6`:

```
gem-hooks/ai-rpg-a1b2c3d4
```

The branch is cut from `main` in the target repo, not from a previous hook PR.

### 3.2 Commit message

```
hooks(gem-ai-rpg): register share URL + embed config (run_a1b2c3d4e5f6)
```

### 3.3 Frontend PR — files touched

In `jleechanorg/ai_universe_frontend`:

```
src/
  routes/
    gems/
      <shareToken>.ts                       # NEW: route handler
  components/
    GemEmbed/
      registry.ts                           # MODIFIED: append entry for <gemId>
  registry/
    <gemId>.json                            # NEW: full gem config (mirrors GemRegistryEntry)
```

The new `registry/<gemId>.json` is a snapshot of the Firestore `GemRegistryEntry` at
the moment the PR was opened. It is the source of truth for the frontend even if
Firestore is briefly unavailable.

### 3.4 Landing-page PR — files touched

In `jleechanorg/ai_universe_landing` (only when `visibility="public"`):

```
content/
  gems/
    <gemId>.md                              # NEW: markdown card
public/
  og/
    gem-<gemId>.png                         # NEW: OG image
src/
  data/
    public-registry.json                    # MODIFIED: append entry
```

The markdown card uses the same frontmatter shape as the rest of the landing page
content, with the gem's name, description, install command, and a link to the share
URL.

### 3.5 PR body

The PR body is auto-generated and contains:

- Link to the backend `PipelineRun` doc
- Link to the Firestore `GemRegistryEntry`
- The full `GemRegistryEntry` payload (so reviewers don't have to auth into Firestore
  to see what they're approving)
- The Cloud Run URL
- A "Checklist" with: (a) the gem boots, (b) the install command works, (c) the
  embed renders

## 4. Soft-fail behavior

A failed cross-repo PR **does not unpublish the gem**. The failure modes are:

| Failure | What happens | User impact |
|---------|--------------|-------------|
| `gh pr create` fails (network, 4xx/5xx) | Stage 8 logs the error, appends `hooks.failed` to audit log, advances the pipeline to `complete` | Embed route appears 1-2 days late |
| `gh pr create` fails because the target repo has branch protection requiring an approval | Same as above | Same as above |
| Frontend build / lint fails on the hook PR | The hook PR is still open; CI is the target repo's problem | Embed route never auto-lands; a human has to merge after CI passes |
| Landing-page PR fails because the OG-image pipeline is down | Same as above (the markdown card is still added; the OG image is a separate file) | Card still lands; OG image is 404 until the pipeline recovers |

In every case, the user gets a Slack DM with the link to the failed (or stuck) PR.
The DM is sent by the Stage 8 hook to the `authorUid`'s Slack user (looked up via
Firebase Auth → Slack mapping). If the Slack mapping is missing, the DM is skipped
(not an error).

**Why soft-fail:** the gem is already deployed and serving traffic. The embed route
is a nice-to-have; it lets the user share the gem via a pretty URL, but the
`claude mcp add --transport http <gemId> https://<cloudRunUrl>/mcp` install command
works regardless. Unpublishing a working gem because a marketing PR failed is
backwards.

**Why not retry forever:** the failure is usually structural (branch protection, CI
config, missing secret in the target repo). Retrying without diagnosis makes the
audit log noisy. We fail loud (Slack DM) and let a human fix it.

## 5. Audit log entries

Every Stage 8 action writes one or more rows to `gem_audit_log`:

```
{ type: "hooks.frontend.pr_opened",  runId, gemId, prUrl, branch, ts }
{ type: "hooks.landing.pr_opened",   runId, gemId, prUrl, branch, ts }   // public only
{ type: "hooks.slack.posted",        runId, gemId, channel, ts }         // public only
{ type: "hooks.completed",           runId, gemId, okCount, failCount, ts }
{ type: "hooks.failed",              runId, gemId, prName, error, ts }   // on any failure
{ type: "gem.live",                  runId, gemId, cloudRunUrl, ts }     // final row
```

The `hooks.completed` row is written exactly once per pipeline run, regardless of
how many sub-actions succeeded or failed. The `hooks.failed` row is written per
failure (so a run with two failures gets two `hooks.failed` rows plus one
`hooks.completed` row).

These rows power:

- The `#ai-universe-gems` Slack channel's read-only mirror (one Slack message per
  `gem.live` row).
- The admin `/api/audit?gemId=<id>` tool.
- The `gh` CLI's PR-description link back to the pipeline (via `runId`).

## 6. How to roll back

Rollback is the inverse of Stage 8, performed manually when:

- A gem turns out to be broken in production and we need to take it down
- A cross-repo hook PR introduced a regression
- A gem's visibility needs to drop from `public` to `unlisted` or `private`

### 6.1 The two-step rollback

**Step 1 — Revert the cross-repo PR(s).**

In each of `ai_universe_frontend` and `ai_universe_landing`, find the
`gem-hooks/<gemId>-<shortRunId>` branch (open or merged) and revert it:

```bash
# In ai_universe_frontend
gh pr view --search "gem-hooks/ai-rpg-" --state all
gh pr close <PR_NUMBER> --delete-branch          # if still open
# or, if merged:
gh pr revert <PR_NUMBER> --branch revert-ai-rpg
```

Merging the revert removes the embed route and the `registry/<gemId>.json` file from
the frontend, and the card from the landing page. The share URL at
`https://ai-universe.app/gems/<shareToken>` will start returning 404 within a few
minutes of the merge + deploy.

**Step 2 — Patch the gem's `cloudRunUrl` in Firestore.**

The gem's Cloud Run service is still up and serving MCP traffic; Step 1 only removed
the pretty share-URL. To take the gem fully offline:

```bash
# Option A: soft-delete (recoverable for 30 days)
gcloud firestore update gems/<gemId> \
  --data '{"status":"deleted","cloudRunUrl":null,"updatedAtIso":"<NOW>"}' \
  --project=ai-universe-b3551

# Option B: hard-disable (immediate, no recovery)
gcloud run services delete gem-<gemId>-prod --region=us-central1 --project=ai-universe-2025
gcloud firestore update gems/<gemId> \
  --data '{"status":"deleted","cloudRunUrl":null,"updatedAtIso":"<NOW>"}' \
  --project=ai-universe-b3551
```

After Step 2, the install command
`claude mcp add --transport http <gemId> https://<cloudRunUrl>/mcp` fails with a
connection error, and the share URL returns 410 Gone.

**Audit log row:**

```
{ type: "gem.rolled_back", runId, gemId, method: "manual|workflow", revertedPrs: [...], ts }
```

### 6.2 What rollback does NOT do

- Does **not** delete the `gems/<id>/` source directory. The committed source is
  the audit record of what the pipeline produced.
- Does **not** delete the Firestore `gem_runs/<runId>` doc. It is append-only.
- Does **not** delete the audit log rows. They are append-only.
- Does **not** delete the Cloud Run image. It stays in GCR
  (`gcr.io/ai-universe-2025/gem-<id>:<version>`) for the standard 90-day GCR retention.
  To hard-delete: `gcloud container images delete gcr.io/ai-universe-2025/gem-<id>:<version>`.

## 7. Manual override: `rollback-gem.yml`

For the common case ("a gem was just published, something is wrong, take it down"),
a GitHub Actions workflow exists: `rollback-gem.yml` (in
`.github/workflows/rollback-gem.yml`, deployed in Phase 1).

**Usage:**

```bash
gh workflow run rollback-gem.yml --field gem_id=<gemId>
```

This triggers a workflow that:

1. Reads `gems/<gemId>` from Firestore (project `ai-universe-b3551`).
2. Reverts any open or merged `gem-hooks/<gemId>-*` PRs in `ai_universe_frontend`
   and `ai_universe_landing`.
3. Sets `gems/<gemId>.status="deleted"` and `gems/<gemId>.cloudRunUrl=null`.
4. Soft-deletes the Cloud Run service (`gem-<gemId>-prod`) — sets `--min-instances=0`
   and `--max-instances=0`, effectively turning it off without losing the
   configuration.
5. Appends `{ type: "gem.rolled_back", method: "workflow", ... }` to `gem_audit_log`.
6. Posts a confirmation to `#ai-universe-gems`.

**It does NOT:**

- Hard-delete the Cloud Run service (that's `gcloud run services delete`; intentional,
  in case you want to restore).
- Hard-delete the GCR image.
- Delete the Firestore `gems/<gemId>` doc (soft-delete is recoverable for 30 days).

**Required permissions:** the workflow uses a service account with `roles/run.admin`,
`roles/firebase.firestoreAdmin` (scoped to the gems collection), and
`roles/secretmanager.secretAccessor`. The workflow is `workflow_dispatch` only — no
schedule, no other triggers.

**Rollback the rollback:**

```bash
# In gcr.io/ai-universe-2025/gem-<gemId>:<version>, the image is still there
# Re-deploy with the same image:
gcloud run deploy gem-<gemId>-prod \
  --image gcr.io/ai-universe-2025/gem-<gemId>:<version> \
  --region us-central1 --project ai-universe-2025 \
  # ...same flags as deploy.gem.sh

# Then in Firestore, flip status back to "live" and restore cloudRunUrl
```

If the hook PRs were reverted, re-run Stage 8 manually (or open fresh hook PRs).

## See also

- [`docs/gem-builder.md`](./gem-builder.md) — the full Stage 8 spec in the context
  of the 8-stage pipeline (the *upstream* doc)
- [`docs/gem-authoring.md`](./gem-authoring.md) — how to author a gem (Stage 8 is
  what happens *after* your gem is published)
- [`docs/cloudrun-deploy.md`](./cloudrun-deploy.md) — the per-gem Cloud Run deploy
  contract that the rollback workflow reverts
- [`backend/src/agents/stages/08-registry-hooks.md`](../backend/src/agents/stages/08-registry-hooks.md)
  — stage-level source-of-truth
- [`AGENTS.md`](../AGENTS.md) — repo-level guidelines (deploy contract, security)
