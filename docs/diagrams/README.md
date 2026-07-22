# Diagrams index

All required Phase 0 diagrams (spec §28.25 + build-prompt §3) are authored as Mermaid
**inside** the document they belong to, so they stay next to the text they explain and
never drift. This index points to each.

| Required diagram | Location |
|---|---|
| System architecture | `../ARCHITECTURE.md` §5 |
| Deployment topology | `../ARCHITECTURE.md` §6 |
| Event / pipeline processing | `../EVENT_SCHEMA.md` §5 |
| Task lifecycle | `../TASK_STATE_MODEL.md` §2 |
| Approval / authority flow | `../AUTHORITY_MATRIX.md` §5 |
| AI decision → human approval | `../AI_ORCHESTRATION.md` §7 |
| Receipt → QuickBooks flow | `../PAYMENT_AND_RECEIPT_MODEL.md` §9 and `../QUICKBOOKS_INTEGRATION_MODEL.md` §4 |
| Company isolation model | `../SECURITY_AND_PRIVACY_MODEL.md` §2 |
| Major data relationships (ER) | `../DATA_MODEL.md` §9 |
| Capacity model | `../WORKFORCE_CAPACITY_MODEL.md` §5 |
| Attendance state (pilot) | `../ATTENDANCE_AND_SITE_MODEL.md` §4 |
| GPS/CCTV/site correlation (gated, reference) | `../CCTV_GPS_AND_FLEET_MODEL.md` §4 |
| Phase dependencies | `../PHASED_IMPLEMENTATION_PLAN.md` |
| Health/observability | `../OBSERVABILITY.md` §5 |

GitHub, VS Code, and most Markdown viewers render Mermaid inline.
