# V5 pack — NOT RECEIVED

> **Read this before assuming a V5 master guide exists in this repository. It does not.**

## What this directory is for

`docs/autonomy/v5/` is the durable home for the V5 autonomous-continuation instructions. The
bootstrap that created this branch was asked to place five documents here, under stable repository
names:

| Expected path | Source document |
|---|---|
| `docs/autonomy/v5/MASTER_AUTONOMOUS_DEV_GUIDE.md` | `SINGHA_AI_BUSINESS_MANAGER_MASTER_AUTONOMOUS_DEV_GUIDE_v5.md` |
| `docs/autonomy/v5/CURRENT_HANDOFF.md` | `SINGHA_AI_BUSINESS_MANAGER_CURRENT_HANDOFF_v5.md` |
| `docs/autonomy/v5/USAGE_OPTIMISATION_POLICY.md` | `SINGHA_AI_BUSINESS_MANAGER_USAGE_OPTIMISATION_POLICY_v5.md` |
| `docs/autonomy/v5/CONDUCTOR_BOOT_BRIEF.md` | `SINGHA_AI_BUSINESS_MANAGER_CONDUCTOR_BOOT_BRIEF_v5.md` |
| `docs/autonomy/v5/PACK_MANIFEST.md` | the pack manifest |

## Why they are absent

**The pack did not arrive in the bootstrap session.** The attachment directory (`/mnt/attach`) was
empty and no file matching any of those names existed anywhere on the container filesystem. The
documents were referenced by the instruction but not delivered with it.

They were **not** written from memory, inferred, or reconstructed. A governance document that a
later agent would treat as authoritative — one that decides what "done" means, how usage is
budgeted, and what Conductor may do without asking — must be the owner's actual text. Inventing a
plausible substitute would be worse than having none, because it would be obeyed.

## What this means for Conductor

**Do not proceed as though the V5 guide exists.** Until the five files above are present in this
directory:

* The governing documents remain the ones already in this repository — the precedence order in
  `CLAUDE.md` and `AGENTS.md`, the requirement register at
  `docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml`, the findings register at
  `docs/autonomy/OPEN_FINDINGS_REGISTER.md`, and the state controller at
  `docs/autonomy/AUTONOMOUS_DEVELOPMENT_STATE.json`.
* Everything else the bootstrap was asked to establish — the verified continuation branch, the
  PR #27 acceptance record, the reconciled requirement totals and the next resumable sequence —
  **is** in place. See the state file and the bootstrap PR body.

## To complete the bootstrap

Re-send the five documents and copy them to the paths in the table above. Nothing else about this
branch needs to change: it is already based on the verified PR #27 head, and the state it records
is exact. No second requirement register, state controller or architecture truth store was created,
so adding these files is purely additive.
