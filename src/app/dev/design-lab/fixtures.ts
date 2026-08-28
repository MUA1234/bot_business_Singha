/**
 * DESIGN LAB FIXTURES — SYNTHETIC, ISOLATED, NEVER PRODUCTION.
 *
 * These values exist so the Spatial Executive OS design system can be rendered
 * and inspected in a real browser without a database. They are:
 *
 *   - obviously synthetic (names are placeholders, figures are round),
 *   - reachable ONLY from `/dev/design-lab`, which is refused outright when
 *     APP_ENV is production and is additionally gated by NEXT_PUBLIC_DESIGN_LAB,
 *   - never imported by any application route, server action or query.
 *
 * Nothing here is ever presented as business information. Every screen in the
 * lab is banded with a notice saying so.
 */
import type { ConditionSegment } from "@/components/os/ConditionInstrument";
import type { BriefItem, ChangeItem, Cluster, TimelineItem } from "@/components/os/primitives";

export const LAB_SEGMENTS: ConditionSegment[] = [
  { key: "critical", label: "Critical — needs action now", count: 3, tone: "critical" },
  { key: "decide", label: "Needs a decision today", count: 5, tone: "warn" },
  { key: "blocked", label: "Blocked / waiting on someone", count: 4, tone: "blocked" },
  { key: "watch", label: "Watch", count: 7, tone: "info" },
  { key: "ontrack", label: "On track", count: 22, tone: "ok" },
];

export const LAB_EMPTY_SEGMENTS: ConditionSegment[] = [
  { key: "critical", label: "Critical — needs action now", count: 0, tone: "critical" },
  { key: "decide", label: "Needs a decision today", count: 0, tone: "warn" },
  { key: "blocked", label: "Blocked / waiting on someone", count: 0, tone: "blocked" },
  { key: "watch", label: "Watch", count: 0, tone: "info" },
  { key: "ontrack", label: "On track", count: 0, tone: "ok" },
];

export const LAB_CHANGES: ChangeItem[] = [
  {
    id: "c1",
    title: "Supplier bill moved to overdue",
    meta: "SB-2041 · placeholder supplier · 14 days past due",
    when: "07:10",
    tone: "critical",
  },
  {
    id: "c2",
    title: "Two tasks became blocked",
    meta: "Both waiting on the same external confirmation",
    when: "09:24",
    tone: "warn",
  },
  {
    id: "c3",
    title: "Quotation accepted",
    meta: "QT-0188 · placeholder customer",
    when: "11:02",
    tone: "ok",
  },
  {
    id: "c4",
    title: "Cash forecast trough moved earlier",
    meta: "Trough now falls inside the 30-day window",
    when: "11:40",
    tone: "warn",
  },
  {
    id: "c5",
    title: "Inbound message queue drained",
    meta: "No unprocessed inbound events remain",
    when: "12:15",
    tone: "info",
  },
];

export const LAB_BRIEF: BriefItem[] = [
  {
    id: "b1",
    band: "act",
    title: "Overdue payables exceed the cash buffer",
    detail: "Two bills past due; the forecast trough falls inside 30 days.",
    provenance: "system",
  },
  {
    id: "b2",
    band: "act",
    title: "A licence renewal falls due in 6 days",
    detail: "No renewal record has been opened against it.",
    provenance: "system",
  },
  {
    id: "b3",
    band: "decide",
    title: "Three payment approvals are waiting on your authority",
    detail: "Oldest has been waiting 4 days.",
    provenance: "system",
  },
  {
    id: "b4",
    band: "decide",
    title: "Deferring the second site fit-out would hold the trough above zero",
    detail: "Based on committed outflows only; no revenue assumption is made.",
    provenance: "ai",
  },
  {
    id: "b5",
    band: "watch",
    title: "One team is above declared capacity for a second week",
    detail: "Utilisation from recorded capacity snapshots.",
    provenance: "system",
  },
  {
    id: "b6",
    band: "opportunity",
    title: "A dormant customer opened a conversation after 90 days",
    detail: "No opportunity has been raised against it yet.",
    provenance: "ai",
  },
  {
    id: "b7",
    band: "clear",
    title: "Reconciliation is complete for the last closed period",
    provenance: "system",
  },
];

export const LAB_CLUSTERS: Cluster[] = [
  {
    key: "critical",
    name: "Overdue",
    nodes: [
      { id: "t1", label: "Confirm delivery window with supplier", meta: "6d", band: "critical", icon: "timer" },
      { id: "t2", label: "Resolve unmatched bank line", meta: "4d", band: "critical", icon: "git-branch" },
      { id: "t3", label: "Return signed variation", meta: "2d", band: "critical", icon: "scroll-text" },
    ],
  },
  {
    key: "blocked",
    name: "Blocked",
    nodes: [
      { id: "t4", label: "Site survey — awaiting access", band: "blocked", icon: "map-pin" },
      { id: "t5", label: "Price confirmation — awaiting finance", band: "blocked", icon: "help-circle" },
      { id: "t6", label: "Vehicle inspection — awaiting workshop", band: "blocked", icon: "wrench" },
      { id: "t7", label: "Contract review — awaiting counsel", band: "blocked", icon: "gavel" },
    ],
  },
  {
    key: "week",
    name: "Due this week",
    nodes: [
      { id: "t8", label: "Issue monthly statements", meta: "Wed", icon: "receipt" },
      { id: "t9", label: "Close the period", meta: "Thu", icon: "check-circle" },
      { id: "t10", label: "Supplier performance review", meta: "Thu", icon: "factory" },
      { id: "t11", label: "Fleet fuel reconciliation", meta: "Fri", icon: "fuel" },
      { id: "t12", label: "Capacity plan for next month", meta: "Fri", icon: "gauge" },
    ],
  },
  {
    key: "done",
    name: "Completed this week",
    nodes: [
      { id: "t13", label: "Quarterly insurance renewal", band: "done", icon: "shield" },
      { id: "t14", label: "New starter onboarding", band: "done", icon: "user-round" },
    ],
  },
];

export const LAB_TIMELINE: TimelineItem[] = [
  { id: "m1", when: "Completed · 14 Jun", title: "Design sign-off", position: "past" },
  { id: "m2", when: "Completed · 02 Jul", title: "Long-lead items ordered", position: "past" },
  {
    id: "m3",
    when: "In progress · due 29 Aug",
    title: "First fix complete",
    body: "Two dependencies are blocked; the critical path runs through the workshop inspection.",
    position: "current",
  },
  { id: "m4", when: "Planned · 19 Sep", title: "Commissioning", position: "future" },
  { id: "m5", when: "Planned · 10 Oct", title: "Handover", position: "future" },
];

export const LAB_NOTICE =
  "Design lab — synthetic placeholder values, rendered so the interface can be inspected without a database. Nothing here is business information.";
