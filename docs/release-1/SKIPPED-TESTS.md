# Every skipped test, named

`npm test` reports "4 skipped". An aggregate is not an account: it hides whether a skip is a
truthful "not measured" or a security proof quietly switched off. All four are listed below, with
what happened to each.

**Outcome: 2 of the 4 were runnable here and now RUN. The other 2 require a paid external
capability and stay skipped, deliberately.** No canonical security, migration, lifecycle or
execution proof is skipped.

---

## 1–2. `tests/kernel/no-outbound-network.test.ts` — **NOW RUN**

| | |
|---|---|
| Tests | `refuses fetch`, `refuses raw http and https requests` |
| Skip condition | `describe.skipIf(!guarded)` — `globalThis.__NO_OUTBOUND_NETWORK__ !== true` |
| Why it was skipped | The flag is set only by `vitest.no-network.config.ts`. Under the ordinary config the guard is not installed, so the self-test would fail |
| Capability required | **Present.** It is a second local vitest config, nothing more |

**This was the real finding.** The suite is the *self-test for the outbound-network guard* —
"a guard nobody checks is a guard that silently stops working" — and the config that runs it was
in the repository but **wired to nothing**: no npm script, no CI step. The Release 1 brief lists
the outbound-network guard as a required gate, and it was not being run.

Fixed:

```
npm run test:no-network      # new script
```

and a CI step in the `unit` job. Measured result:

```
Test Files  27 passed (27)
     Tests  746 passed (746)      ← including the 2 formerly-skipped guard self-tests
```

Every kernel suite passes with `fetch`, `http.request` and `https.request` replaced by throwing
stubs. Asserting "this code contacts nothing" about code you wrote is easy; asserting it about
everything it imports is not, and passing under this config is the proof.

---

## 3–4. `tests/campaign/live-eval.test.ts` — **RETAINED as skipped**

| | |
|---|---|
| Tests | `records the exact model id and prompt version with every scored run`; `scores a representative subset` |
| Skip condition | `describe.skipIf(!enabled)` — `ANTHROPIC_API_KEY` absent |
| Capability required | **A paid model API key.** Genuinely unavailable, and running it would incur model spend, which is not authorised |

Retained, for two reasons that point the same way:

1. **The capability is external and paid.** There is no key here, and supplying one would be a
   business decision about spend, not a test-environment fix.
2. **The skip is itself the honest result.** The file's own header says so: *"the verification
   campaign could not score live-model decision quality and refused to invent numbers… a skipped
   test is a truthful 'not measured', which is the whole point."*

**These two skips are not a coverage hole**, because the same file carries two tests that run
unconditionally and assert the thing that matters without a key:

* `is BLOCKED, not passed, without a key` — the evaluation reports **blocked**, never a fabricated
  score;
* `the evaluation route names a model but is wired to no production path` — nothing in production
  reaches it.

So what is skipped is *measuring live model quality*. What is **not** skipped is *the guarantee
that unmeasured quality is reported as unmeasured, and that the harness is not reachable from a
production path*.

---

## Nothing else is conditional

`grep` over the unit tree finds exactly two `skipIf` declarations and **no** `it.skip`,
`describe.skip` or `test.skip` anywhere. The integration suites use `describe.skipIf(!enabled)`
on `DATABASE_URL`, which is how they refuse to run against a non-loopback database — a safety
guard, not a skipped proof, and every campaign in this release supplies that URL.

| Category | Any skipped? |
|---|---|
| Security / RLS / isolation | none |
| Migration | none |
| Lifecycle | none |
| Execution / autonomy boundary | none |
| Outbound-network guard | **none, as of this change** |
