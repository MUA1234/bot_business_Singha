# Autonomous blockers

Only the affected action stops; the program continues on independent requirements.

| # | Blocker | Blocks | Exact owner action required |
|---|---|---|---|
| 1 | No provider key | MOD-001 live-model evaluation | Supply `ANTHROPIC_API_KEY` via local/staging secret configuration. Never paste it into chat or a file. |
| 2 | Hosted DB at 0038–0041 | Any hosted verification of 0042–0069 | Apply `docs/architecture-v2/HOSTED_MIGRATION_0042_TO_0068.sql`, then 0069, on the hosted database. |
| 3 | All V3.1 flags OFF | AIM-004…007 | Activate per slice after staging UAT. |
| 4 | GitHub Actions runner provisioning | CI evidence | Repository/account runner settings. Not retried per instruction. |
| 5 | No staging environment | staging_verified for every requirement | Provision staging + credentials. |
| 6 | Public repository | IP-001 | Decide whether proprietary prompts/evaluation data move to a private repository or package. |
| 7 | Specs awaiting approval | AST-001, LNG-001 | Approve (or amend) the two specifications before implementation begins. |
| 8 | Authority mapping sign-off | FOUND-004 permanence | Approve the impact→level mapping or direct its replacement by `authority_rules` rows. |
