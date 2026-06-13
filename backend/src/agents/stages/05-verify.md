# AI Universe Lite — Stage 5 Verify

**Deterministic.** Runs the standard verification suite on the generated gem.

## Behavior

```bash
cd gems/<id>/
npm install --no-audit --no-fund
npm run type-check      # tsc --noEmit
npm run lint            # eslint src
npm test                # jest (per-tool unit tests)
```

## Output

`VerifyReportSchema`:

```ts
{
  typeCheckOk: boolean,
  lintOk: boolean,
  unitTestsOk: boolean,
  unitTestCount: integer >= 0,
  durationMs: integer >= 0,
  errors: string[],   // collected from all 3 steps
}
```

## Failure

If any step fails, the pipeline stops and surfaces the `errors[]` array to the user via the `GET /api/gems/<runId>` polling endpoint.

## Why deterministic

Same as Stage 4 — verification is a contract, not a creative task. If a build is wrong, the user sees real compiler errors, not a model apologizing.
