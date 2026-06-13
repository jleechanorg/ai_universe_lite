---
name: gem-create
description: The user-facing entry point for AI Universe Lite — turn a natural-language prompt into a shareable, self-contained MCP gem.
---

# `/gem-create`

The main slash command that runs the AI Universe Lite 8-stage gem-builder pipeline.

## Trigger

Any of:

- `/gem-create "<prompt>"`
- `/gem-create <prompt> --ref <file>` (one or more)
- `/gem-create <prompt> --bundle` (concatenate refs into the gem's system prompt)

## What it does

1. Calls the backend MCP tool `gem_create` (or HTTP `POST /api/gems`) with the prompt + refs.
2. Backend runs the 8-stage pipeline; returns `runId` + `pollUrl`.
3. Frontend / host polls `GET /api/gems/<runId>` every 2s and renders the pipeline timeline.
4. On success, returns the share URL + install command:
   - Share URL: `https://ai-universe.app/gems/<shareToken>`
   - Install: `claude mcp add --transport http <gemId> https://<cloudRunUrl>/mcp`

## Constraints

- One gem per `/gem-create` invocation.
- Reference uploads: 50 MB/file, 200 MB/gem, 20 files/gem max.
- The 8 stages are sequential and resumable; if the server crashes mid-`04-build`, resume picks up at the next stage.
- Production deploys are gated by `gem-publish.yml` GitHub Actions with manual approval; local `prod` deploys are blocked.

## Pipeline

See `docs/gem-builder.md` for the full 8-stage design.

## Examples

```
/gem-create "an MCP server that summarizes GitHub PRs"
/gem-create "an AI RPG engine with character sheets + dice + combat" --ref worldarchitect_ai_combined_prompts.md --bundle
/gem-create "an MCP server that turns screenshots into JIRA tickets" --ref api-spec.yaml
```

## Source

`scripts/create-gem.sh` is the local CLI equivalent of this skill.
