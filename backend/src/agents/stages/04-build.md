# AI Universe Lite — Stage 4 Build

**Deterministic.** Pure templating. No LLM in the loop.

## Behavior

Given a validated `GemSpec`:

1. Create `gems/<id>/` directory structure:
   - `package.json`
   - `tsconfig.json`
   - `src/server.ts` (from `templates/server.ts.tmpl`)
   - `src/tools/<tool_name>.ts` (one per spec tool, from `templates/tool.ts.tmpl`)
   - `src/references.ts` (loader for `gs://ai-universe-lite-refs/intake/<intakeId>/`)
   - `Dockerfile.gem` (from `templates/Dockerfile.gem.tmpl`)
   - `cloudbuild.gem.yaml` (from `templates/cloudbuild.gem.tmpl`)
   - `deploy.gem.sh` (from `templates/deploy.gem.sh.tmpl`)
   - `README.md` (auto-generated from gem metadata)
   - `__tests__/<tool_name>.test.ts` (per-tool unit tests)

2. Render templates with the spec injected.
3. Write to `gems/<id>/` (gitignored except `ai-rpg`).
4. Return `GemBuildResultSchema`:
   ```ts
   { gemDir, files[], entrypoint, imageTag }
   ```

## What it does NOT do

- Does not run `npm install` (Stage 5 verify does).
- Does not build the Docker image (Stage 7.5 deploy does).
- Does not call any LLM.

## Why deterministic

Spec → source is mechanical. We want build to be reproducible, fast, and debuggable. LLMs add variance and tokens without value here.
