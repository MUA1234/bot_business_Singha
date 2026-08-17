# Autonomous decision log

Decisions taken without asking, and why. Each is reversible and recorded so the owner can overrule.

| # | Decision | Reasoning |
|---|---|---|
| 1 | Landed the in-flight Part 2 slice to a green checkpoint before building the autonomy layer | The controller instruction's own §17.1 says preserve the active PR stack and §10 says finish or revert to a coherent checkpoint. Abandoning a near-green tree to start scaffolding would have violated both. |
| 2 | Wrote a minimal YAML reader instead of adding a YAML dependency | CLAUDE.md's COST RULE forbids new dependencies without recorded justification, and the register uses a tiny fixed subset. A dependency is not worth the supply-chain surface on a public repository. |
| 3 | Registered 21 requirements now and listed 12 groups as `_pending_population` | Populating from code I have verified is honest; inventing records for groups I have not yet traced would put fiction in the authoritative register. The unexpanded groups are counted and reported, so silence cannot read as completeness. |
| 4 | The sweeper's processor returns a non-retryable failure rather than a placeholder success | FOUND-003 is not built. A processor that pretended to handle events would be exactly the "UI claims an action occurred" defect class this program exists to eliminate. Events dead-letter visibly instead. |
| 5 | Extended `source_events_status_check` additively rather than replacing it | Existing routes write the legacy values. Narrowing a constraint an existing writer depends on is a breaking change; the new lifecycle values are added alongside. |
| 6 | Named roles explicitly in the 0069 REVOKE statements | Supabase's default privileges grant EXECUTE to `authenticated` directly, so a PUBLIC-only revoke leaves it reachable. The migration's own fail-closed assertion caught this. |
| 7 | Kept the interim `authorityFloor` as a fail-closed fallback rather than deleting it | The owner required the rules engine to be active and tested in the same change as any removal. The floor now only applies when no `AuthorityContext` is available, and that path is flagged `authorityFailedClosed`. |
| 8 | Did not close PRs #5–#12 until each was compared against `main` | The instruction required one final compare. Migrations 0049–0055 and the WP18 documents were each confirmed present before the corresponding PR was closed. |
