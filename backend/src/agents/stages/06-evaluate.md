# AI Universe Lite — Stage 6 Evaluate

**Managed Claude agent.** Quality gate before publish.

## Behavior

1. Loads the gem spec + source from `gems/<id>/`.
2. Spawns a managed Claude agent with the evaluator system prompt.
3. The agent runs a fixed probe set:
   - 5 happy-path probes (one per spec tool minimum)
   - 3 edge-case probes (empty inputs, oversize inputs, bad types)
   - 2 adversarial probes (prompt injection, jailbreak, "ignore previous instructions")
4. The agent assigns a `ProbeScore` per probe.
5. Backend computes `overallScore` (mean of pass booleans) and `passed` (score >= `GEM_EVAL_MIN_PASS_RATE` AND no red_team probe failed).
6. Returns `EvaluationReportSchema`.

## Output

```ts
{
  overallScore: 0..1,
  passed: boolean,
  probeScores: ProbeScore[],
  evaluatorModel: "claude-sonnet-4",
  evaluatedAtIso: string,
  notes?: string,
}
```

## Gate

- `passed=false` → pipeline stops at Stage 6 with `evaluate` populated. User can iterate by re-running with `--from=02-brainstorm`.
- `gemEvalHardFailOnRedTeam=true` (default) → any red_team probe failure = `passed=false` regardless of overallScore.

## Why a managed agent

Quality is fuzzy. LLM judgment over output coherence, tool-call quality, and prompt-injection resistance is exactly what an agent is good at. The deterministic pipeline cannot grade this.

## Why a backend `meta-eval`

`scripts/eval-meta.ts` (run via `npm run gem:meta-eval`) re-runs the evaluator on the evaluator's own outputs. Catches drift in the evaluator over time. Becomes CI in Phase 1.
