# Step 1 — final-SHA campaign at `531dbb6`

## Preconditions, checked before starting

| | |
|---|---|
| local HEAD == remote | yes, `531dbb65e89ab3643f48a097f4bd4c80314263ef` |
| working tree | clean (0 files) |
| Singha harness containers | 0 |
| harness lock `.r1-security-campaign.lock` | absent |
| other heavy suites running | none |
| unrelated containers on the host | **13**, untouched |

## Result

```
Test Files  2 failed | 22 passed (24)
     Tests  4 failed | 454 passed (458)
  Duration  5277s (campaign 5898s)
```

Baseline for this campaign on an idle machine is **~1200s**. This run was **~5x slower**.

## The four failures, classified

**All four are ENVIRONMENT. None is a product defect and none is a test defect.**

| Test | Classification |
|---|---|
| `r2s-loader-contract > R2S-P — a large source reports a CONTINUATION rather than truncating` | environment |
| `r2s-loader-contract > a DATABASE ERROR marks the domain unobserved and is never reported as all-clear` | environment |
| `r2s-loader-contract > the cycle is IDEMPOTENT across the whole twelve-domain sweep` | environment |
| `r2e-execution-ledger > executes the authorised automatic action end to end` | environment |

Every one reported `Test timed out in 30000ms` — the global `testTimeout` in
`vitest.integration.config.ts`.

### The evidence

**1. The SHA under test cannot have caused them.** `531dbb6` changed exactly two files:
`docs/product-recovery/AUTONOMOUS-STATE.md` and `tests/integration/r1-security-baseline.test.ts`.
Neither is imported by, or shares state with, the two failing files.

**2. They passed at the previous SHA.** The campaign at `4f31446` ran 457 tests and its **only**
failure was `r1-security-baseline > a MANAGER may record a decision` — the test `531dbb6` fixed.
Both of these files passed in that run.

**3. They pass in isolation, now.** `r2e-execution-ledger` alone: **26 passed**, and the specific
test completed in **1103 ms** — against a ceiling of 30,000 ms.

**4. Measured durations show a ceiling problem, not a hang.** The `testTimeout` was raised to 240s
**for measurement only** and restored immediately afterwards. With time to finish, all 49 tests in
the file passed:

| Test | Measured | Ceiling |
|---|---|---|
| a large source reports a CONTINUATION | **44,872 ms** | 30,000 ms |
| a DATABASE ERROR marks the domain unobserved | **36,353 ms** | 30,000 ms |
| the cycle is IDEMPOTENT across the twelve-domain sweep | **30,644 ms** | 30,000 ms |

The third is **644 ms — 2%** over the ceiling. These are heavy tests (520 seeded rows, a full
twelve-domain sweep) that fit inside 30s on an idle machine and do not on this one.

### What was NOT done

The timeout was **not** raised to obtain a green result. It was raised to obtain a number, and
`vitest.integration.config.ts` is byte-identical to its committed form — verified after each
diagnostic run. No test was skipped, weakened or given a per-test extension.

Making these tests lighter would also have been changing the test to get green: the 520-row case
exists precisely because a smaller one did not exercise the continuation boundary.

## Conclusion

**A genuine external resource blocker is proven:** 13 unrelated containers are running on this host,
the campaign runs ~5x slower than baseline, and three tests sit within 50% of the 30s ceiling even
when healthy. Under the owner's Step 1 instruction — *"Do not proceed until the full campaign is
green or a genuine external resource blocker is proven"* — this is the second branch.

The campaign will be re-run at the final SHA at the end of the session. Should the host be quieter
then, it is expected to pass; if it is not, the same four tests will time out for the same measured
reason.
