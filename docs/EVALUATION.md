# Evaluation

CodeCEO's claims are hypotheses until measured. This page says what to measure and how, and what the
bundled tooling can and cannot tell you.

## Hypotheses

| | Claim | Metric |
|---|---|---|
| H1 | Less context is spent per task | input + output tokens per task, total and per agent |
| H2 | Same or better correctness | tests passing, task success rate (hidden tests / reviewer rubric) |
| H3 | Better architectural coherence | contract breaks, boundary violations, cyclic deps added, review score |
| H4 | More parallelism | wall-clock time, number of agents running concurrently |
| H5 | Routing finds the right zone | routing accuracy: owners of the files a reference patch touches |
| H6 | Knowledge survives sessions | success on a task started in a *fresh* chat after the context files exist |

## Offline estimate: `codeceo bench`

```
codeceo bench eval/queries.example.json
```

For each query it routes, builds the briefs of the routed agents, and compares their size with a
*conventional agent proxy* (the whole files holding the ten best global lexical matches). It also reports
routing accuracy against `expectFiles`. **This is a proxy for H1/H5 only.** It does not run a model, so it says
nothing about answer quality, and small repos (under one module's worth of code) show little or negative
savings by design: CodeCEO is one agent there.

## Live protocol (what supports a real claim)

1. **Benchmarks**: pick repositories of increasing size (single-module → ~50k → ~500k+ LOC) and tasks with
   tests: SWE-bench-style issues, plus cross-module refactors and explanation questions with reference
   answers.
2. **Arms**: (A) plain Claude Code; (B) Claude Code + CodeCEO; optionally (C) CodeCEO without persistent
   contexts, and (D) without write scopes, to isolate each mechanism.
3. **Controls**: same model, same task prompts, same tool permissions, fresh checkout, N ≥ 5 runs per task
   (variance is large).
4. **Collect**: token usage from the session transcripts (sum over main + subagents), wall time, pass/fail,
   diffs, and CodeCEO's `ledger.jsonl` for routing and integration verdicts.
5. **H6**: init once, then run each task in a brand-new session and compare with arm A in a new session.
6. **Report** medians with intervals, per repo-size bucket, and include failures: where routing missed,
   where a delegation round trip cost more than reading directly.

Expect CodeCEO to lose on tiny tasks in small repos (delegation has a fixed cost) and to win as repos and
tasks cross module boundaries. The crossover point is the interesting result.
