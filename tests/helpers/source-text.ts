/**
 * Reading source as EVIDENCE, with the prose removed.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * A number of gates in this repository assert things about source text: that the queue panel joins
 * both execution boundaries with `&&`, that `boundary.ts` names no `NEXT_PUBLIC_` variable, that
 * the execution RPCs contain no dynamic SQL. Those assertions are worth having — the defect they
 * catch is introduced in a diff, and that is where it should be caught.
 *
 * They share one failure mode, and it happened four times in a single day's work: the assertion
 * matched the code's own EXPLANATION of the rule. `boundary.ts` says, in a docstring, that the
 * danger is "the future commit that adds `NEXT_PUBLIC_EXECUTION_ENABLED`" — so a test forbidding
 * that name failed on the sentence forbidding it. A migration comment reads "a plan approved under
 * one policy may not execute under another", so a test forbidding `execute ` in a function body
 * failed on a remark about the policy version.
 *
 * Each time the fix was the same and was written out again locally. This is that fix, once.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────────────────────
 *
 * It is not a parser. A `//` inside a string literal, or a `--` inside a quoted SQL identifier,
 * will be treated as the start of a comment. That is acceptable for the assertions above — they
 * ask whether an identifier appears in code — and it would not be acceptable for anything that
 * needed the source back intact. Use it to ASK questions of source, never to rewrite it.
 */

/**
 * TypeScript / JavaScript source with comments removed.
 *
 * The `[^:]` guard before `//` keeps `https://…` inside a string from eating the rest of its line,
 * which is the one case common enough here to be worth handling.
 */
export function codeOnlyTs(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** SQL source with `--` line comments removed. Block comments are not used in this repository. */
export function codeOnlySql(source: string): string {
  return source.replace(/^\s*--.*$/gm, "");
}
