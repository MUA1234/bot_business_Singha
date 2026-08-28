import Link from "next/link";
import { Icon } from "@/components/Icon";
import { ConditionInstrument } from "@/components/os/ConditionInstrument";
import {
  AuthorityNotice,
  ChangeLedger,
  Consequence,
  Constellation,
  ExecutiveBriefing,
  Facts,
  Matter,
  PageHead,
  Provenance,
  ProvenanceTag,
  Section,
  Signal,
  SpatialTimeline,
  StateNote,
} from "@/components/os/primitives";
import {
  LAB_BRIEF,
  LAB_CHANGES,
  LAB_CLUSTERS,
  LAB_EMPTY_SEGMENTS,
  LAB_SEGMENTS,
  LAB_TIMELINE,
} from "./fixtures";

/**
 * The design lab's own index: every instrument, material, depth level, signal
 * and honest state on one page, so a change to the design system can be seen
 * everywhere it lands rather than screen by screen.
 */
export default function DesignLabPage() {
  return (
    <>
      <PageHead
        eyebrow="Spatial Executive OS"
        title="Design lab"
        lede="Every material, depth level, instrument, signal and honest state in the system, rendered against synthetic placeholder values."
        actions={
          <>
            <Link href="/dev/design-lab/command" className="btn ghost sm">
              Command Centre
            </Link>
            <Link href="/dev/design-lab/states" className="btn ghost sm">
              States
            </Link>
          </>
        }
      />

      {/* ── THE SIGNATURE COMPOSITION ─────────────────────────────────── */}
      <Section title="Command composition" meta="instrument · briefing · change ledger" />
      <div className="centre">
        <div className="centre-summary card pad-lg">
          <ConditionInstrument segments={LAB_SEGMENTS} />
        </div>
        <div className="centre-action stack gap-3">
          <div className="card">
            <div className="sec" style={{ marginTop: 0 }}>
              <span className="sec-title">AI executive brief</span>
              <span className="sec-rule" />
            </div>
            <ExecutiveBriefing items={LAB_BRIEF} />
          </div>
          <div className="card">
            <div className="sec" style={{ marginTop: 0 }}>
              <span className="sec-title">What changed since yesterday</span>
              <span className="sec-rule" />
            </div>
            <ChangeLedger items={LAB_CHANGES} since="yesterday" />
          </div>
        </div>
      </div>

      {/* ── PRIORITY MATTERS ──────────────────────────────────────────── */}
      <Section title="Priority matters" meta="depth carries urgency" />
      <div className="field-matters">
        <Matter
          kind="Payment approval"
          kindIcon="banknote"
          band="critical"
          title="Placeholder supplier — first fix materials"
          value="LKR 1,840,000"
          valueTone="critical"
          facts={[
            { k: "Due", v: "Overdue by 14 days" },
            { k: "Budget line", v: "Site works" },
            { k: "Requested by", v: "placeholder.user" },
            { k: "Evidence", v: "Bill + delivery note" },
          ]}
          footer={<Signal kind="critical">Requires finance authority</Signal>}
        />
        <Matter
          kind="Blocked project"
          kindIcon="git-branch"
          band="high"
          title="Second site fit-out"
          facts={[
            { k: "Blocker", v: "Workshop inspection" },
            { k: "Days delayed", v: "9" },
            { k: "Owner", v: "placeholder.team" },
            { k: "Impact", v: "Commissioning date" },
          ]}
          footer={<Signal kind="blocked">Waiting on an external party</Signal>}
        />
        <Matter
          kind="Staff capacity"
          kindIcon="gauge"
          band="high"
          title="Operations team above declared capacity"
          value="118%"
          valueTone="warn"
          facts={[
            { k: "Basis", v: "Capacity snapshots" },
            { k: "Weeks", v: "2 consecutive" },
            { k: "Open work", v: "17 tasks" },
            { k: "Leave booked", v: "1 person" },
          ]}
        />
        <Matter
          kind="Customer escalation"
          kindIcon="user-round"
          band="normal"
          title="Placeholder customer — delivery promise at risk"
          facts={[
            { k: "Promised", v: "Friday" },
            { k: "Channel", v: "WhatsApp" },
            { k: "Owner", v: "placeholder.user" },
            { k: "Last contact", v: "2 days ago" },
          ]}
        />
        <Matter
          kind="Completed"
          kindIcon="check-circle-2"
          band="done"
          title="Quarterly insurance renewal filed"
          facts={[{ k: "Closed", v: "Yesterday" }]}
        />
      </div>

      {/* ── PROVENANCE ────────────────────────────────────────────────── */}
      <Section title="Provenance" meta="advice, state, decision and action must never look alike" />
      <div className="grid cols-2">
        <div className="card stack gap-3">
          <Provenance kind="system">
            <p className="muted small">
              Two supplier bills are past due. Derived deterministically from the bill records and
              today&apos;s date.
            </p>
          </Provenance>
          <Provenance kind="ai" label="AI advice · confidence 0.72">
            <p className="muted small">
              Deferring the second fit-out would hold the cash trough above zero. Based on committed
              outflows only; no revenue assumption is made.
            </p>
          </Provenance>
        </div>
        <div className="card stack gap-3">
          <Provenance kind="human">
            <p className="muted small">
              placeholder.owner returned the request for a corrected delivery note.
            </p>
          </Provenance>
          <Provenance kind="approved">
            <p className="muted small">
              Expense claim approved by placeholder.finance under the LKR 250,000 limit.
            </p>
          </Provenance>
          <Provenance kind="done">
            <p className="muted small">Settlement recorded against the bill. Reversal available.</p>
          </Provenance>
        </div>
      </div>

      {/* ── SIGNALS ───────────────────────────────────────────────────── */}
      <Section title="Signals" meta="shape + colour + word — never colour alone" />
      <div className="card">
        <div className="row wrap gap-3">
          <Signal kind="ok">On track</Signal>
          <Signal kind="warn">At risk</Signal>
          <Signal kind="critical">Critical</Signal>
          <Signal kind="info">Informational</Signal>
          <Signal kind="blocked">Blocked</Signal>
          <Signal kind="offline">Offline</Signal>
        </div>
        <hr className="mat-divider" style={{ margin: "var(--sp-4) 0" }} />
        <div className="row wrap gap-2">
          <ProvenanceTag kind="measured" />
          <ProvenanceTag kind="inferred" />
          <ProvenanceTag kind="missing" />
          <span className="small dim">
            An operational figure must say where it came from. Telemetry is never invented.
          </span>
        </div>
      </div>

      {/* ── MATERIALS ─────────────────────────────────────────────────── */}
      <Section title="Materials" meta="five materials, not one repeated glass card" />
      <div className="grid cols-3">
        <div className="mat-glass" style={{ padding: "var(--sp-5)" }}>
          <span className="t-label">A · Spatial glass</span>
          <p className="muted small mt-1">
            High-level floating surfaces. Translucent, blurred, environment-tinted, with a fine edge
            illumination catching the key light.
          </p>
        </div>
        <div className="mat-smoked" style={{ padding: "var(--sp-5)" }}>
          <span className="t-label">B · Smoked glass</span>
          <p className="muted small mt-1">
            Secondary operational panels. Less transparent so dense data stays crisp.
          </p>
        </div>
        <div className="mat-instrument" style={{ padding: "var(--sp-5)" }}>
          <span className="t-label">C · Instrument</span>
          <p className="muted small mt-1">
            Gauges, meters and time-sensitive controls. A machined well with a lit top lip.
          </p>
        </div>
        <div className="sheet stacked" data-state="draft">
          <div className="sheet-head">
            <div>
              <span className="sheet-kind">D · Paper / evidence</span>
              <div className="sheet-title">Delivery note — placeholder</div>
            </div>
          </div>
          <p className="muted small">
            Documents are thin physical sheets, not another glass rectangle. Draft, expired and
            unapproved states are unmissable.
          </p>
        </div>
        <div className="mat-metal" style={{ padding: "var(--sp-5)", borderRadius: "var(--radius)" }}>
          <span className="t-label">E · Metal / structural</span>
          <p className="muted small mt-1">
            Rails, dividers and frame elements. Anodised, not chrome, and used sparingly.
          </p>
        </div>
        <div className="card">
          <span className="t-label">Depth</span>
          <p className="muted small mt-1">
            Depth states why a surface is where it is: environment, department, standard information,
            active workspace, priority, critical, focus.
          </p>
        </div>
      </div>

      {/* ── DEPTH LADDER ──────────────────────────────────────────────── */}
      <Section title="Depth ladder" meta="near = active, far = context" />
      <div
        className="card pad-lg"
        style={{ perspective: "var(--cam-perspective)", transformStyle: "preserve-3d" }}
      >
        <div className="grid cols-4" style={{ transformStyle: "preserve-3d" }}>
          <div className="mat-smoked depth-backdrop" style={{ padding: "var(--sp-4)" }}>
            <span className="t-label">Backdrop</span>
            <div className="small muted mt-1">Background intelligence</div>
          </div>
          <div className="mat-smoked depth-dept" style={{ padding: "var(--sp-4)" }}>
            <span className="t-label">Department</span>
            <div className="small muted mt-1">Context, still readable</div>
          </div>
          <div className="mat-smoked depth-active" style={{ padding: "var(--sp-4)" }}>
            <span className="t-label">Active</span>
            <div className="small muted mt-1">The workspace in use</div>
          </div>
          <div className="mat-smoked depth-critical" style={{ padding: "var(--sp-4)" }}>
            <span className="t-label">Critical</span>
            <div className="small muted mt-1">Commands attention by depth, not by flashing</div>
          </div>
        </div>
      </div>

      {/* ── DECISION ──────────────────────────────────────────────────── */}
      <Section title="Decision surface" meta="consequence first, authority stated in words" />
      <div className="card pad-lg">
        <Consequence value="LKR 1,840,000" tone="critical">
          leaves the operating account today and cannot be recalled once the payment is recorded.
          The projected cash trough moves from day 34 to day 12.
        </Consequence>
        <AuthorityNotice>
          <strong>A human with finance authority must decide this.</strong> The AI Manager has
          summarised the evidence and flagged the cash impact; it cannot approve a payment, and
          approving a payment record here is not an instruction to a bank.
        </AuthorityNotice>
        <div className="mt-3">
          <Facts
            items={[
              { k: "Recipient", v: "Placeholder Supplier (Pvt) Ltd" },
              { k: "Purpose", v: "First fix materials" },
              { k: "Bill", v: "SB-2041" },
              { k: "Due", v: "Overdue by 14 days" },
              { k: "Budget line", v: "Site works" },
              { k: "Budget remaining", v: "LKR 410,000", numeric: true },
              { k: "Bank account", v: "", missing: true },
              { k: "Approval chain", v: "Owner → Finance" },
            ]}
          />
        </div>
        <div className="card-footer">
          <button type="button" className="btn ghost">
            <Icon name="corner-down-left" size={15} /> Return for correction
          </button>
          <button type="button" className="btn ghost">
            Request information
          </button>
          <button type="button" className="btn danger">
            Reject
          </button>
          <button type="button" className="btn">
            <Icon name="check-circle" size={15} /> Approve
          </button>
        </div>
      </div>

      {/* ── CONSTELLATION ─────────────────────────────────────────────── */}
      <Section title="Work constellation" meta="a layout, not a chart — every node is a record" />
      <div className="card pad-lg">
        <Constellation clusters={LAB_CLUSTERS} />
      </div>

      {/* ── TIMELINE ──────────────────────────────────────────────────── */}
      <Section title="Spatial timeline" meta="past recedes · current is prominent · future extends" />
      <div className="card pad-lg">
        <SpatialTimeline items={LAB_TIMELINE} />
      </div>

      {/* ── EMPTY & DEGRADED ──────────────────────────────────────────── */}
      <Section title="Honest states" meta="a beautiful failure state is a requirement" />
      <div className="grid cols-2">
        <div className="card">
          <span className="t-label">Nothing outstanding</span>
          <div className="mt-2">
            <ConditionInstrument segments={LAB_EMPTY_SEGMENTS} />
          </div>
        </div>
        <div className="card">
          <span className="t-label">Degraded — condition unknown</span>
          <div className="mt-2">
            <ConditionInstrument segments={LAB_SEGMENTS} degraded />
          </div>
        </div>
      </div>
      <div className="grid cols-2 mt-3">
        <StateNote kind="denied" title="You do not have authority for this">
          This screen needs the finance approval capability. Ask an administrator to grant it, or
          open the record read-only.
        </StateNote>
        <StateNote kind="config" title="Integration not configured">
          The AI gateway is not configured in this environment. Everything else on this screen is
          unaffected.
        </StateNote>
        <StateNote kind="partial" title="Partial data">
          Two of five sources failed to load. Figures shown are incomplete — this is a system
          problem, not a clean bill of health.
        </StateNote>
        <StateNote kind="offline" title="You are offline">
          Showing the last data this device received. Nothing you change will be sent until the
          connection returns.
        </StateNote>
      </div>
    </>
  );
}
