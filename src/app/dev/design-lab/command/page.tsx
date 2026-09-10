import Link from "next/link";
import { Icon } from "@/components/Icon";
import { ConditionInstrument } from "@/components/os/ConditionInstrument";
import {
  ChangeLedger,
  ExecutiveBriefing,
  Facts,
  Matter,
  PageHead,
  Section,
  Signal,
  StateNote,
} from "@/components/os/primitives";
import { LAB_BRIEF, LAB_CHANGES, LAB_SEGMENTS } from "../fixtures";

/**
 * The Owner/CEO Command Centre composition, rendered against synthetic
 * placeholder values.
 *
 * This mirrors the real `CommandCentrePanel` layout exactly — the same
 * instrument, the same banded brief, the same change ledger, the same money
 * band and the same priority field — so the signature screen can be inspected
 * and screenshotted without a database. The real screen renders the same
 * components against real query results.
 */
export default function CommandLabPage() {
  return (
    <>
      <PageHead
        eyebrow="Command Centre"
        title="What needs attention"
        lede="Exceptions across every department, most severe first. On the real screen every figure below is a record in the system — nothing is estimated or illustrative."
        actions={
          <>
            <Link className="btn ghost sm" href="/dev/design-lab">
              <Icon name="chevron-left" size={14} /> Back to the lab
            </Link>
          </>
        }
      />

      <div className="centre">
        <div className="centre-summary card pad-lg">
          <ConditionInstrument segments={LAB_SEGMENTS} label="Today" />
        </div>
        <div className="centre-action stack gap-2">
          <div className="card">
            <Section title="Executive brief" meta={`${LAB_BRIEF.length} matters`} />
            <ExecutiveBriefing items={LAB_BRIEF} />
          </div>
          <div className="card">
            <Section title="What changed" meta="last 24 hours" />
            <ChangeLedger items={LAB_CHANGES} since="yesterday" />
          </div>
        </div>
      </div>

      <Section title="Money" meta="cash · receivables · payables · commitments" />
      <div className="grid cols-4">
        <div className="card stat">
          <div className="k">Cash on hand</div>
          <div className="v">LKR 4,120,900</div>
          <div className="d">3 account(s)</div>
        </div>
        <div className="card stat">
          <div className="k">Receivables outstanding</div>
          <div className="v">LKR 6,845,000</div>
          <div className="d">
            <Signal kind="warn">Overdue LKR 918,000</Signal>
          </div>
        </div>
        <div className="card stat">
          <div className="k">Payables outstanding</div>
          <div className="v">LKR 3,412,000</div>
          <div className="d">
            <Signal kind="critical">Overdue LKR 1,840,000</Signal>
          </div>
        </div>
        <div className="card stat">
          <div className="k">Expected commitments</div>
          <div className="v">LKR 2,260,000</div>
          <div className="d">7 PO(s) / commitment(s) in forecast</div>
        </div>
      </div>

      <Section title="Needs attention" meta="4 open" />
      <div className="field-matters">
        <Matter
          kind="overdue"
          kindIcon="alert-triangle"
          band="critical"
          title="Overdue payables: LKR 1,840,000"
          footer={
            <>
              <Signal kind="critical">Act now</Signal>
              <span className="badge danger">overdue</span>
            </>
          }
        />
        <Matter
          kind="blocked task"
          kindIcon="alert-triangle"
          band="critical"
          title="Two tasks blocked for more than five days"
          footer={
            <>
              <Signal kind="critical">Act now</Signal>
              <span className="badge danger">blocked</span>
            </>
          }
        />
        <Matter
          kind="overdue"
          kindIcon="alert-circle"
          band="high"
          title="Overdue receivables: LKR 918,000"
          footer={
            <>
              <Signal kind="warn">Decide today</Signal>
              <span className="badge warn">overdue</span>
            </>
          }
        />
        <Matter
          kind="capacity"
          kindIcon="info"
          band="normal"
          title="One team above declared capacity for a second week"
          footer={
            <>
              <Signal kind="info">Watch</Signal>
              <span className="badge info">capacity</span>
            </>
          }
        />
      </div>

      <Section title="Module index" meta="the whole area, reachable from its front door" />
      <div className="grid cols-3">
        {[
          { href: "/dev/design-lab", label: "Chart of accounts", icon: "clipboard", note: "The account tree everything posts to" },
          { href: "/dev/design-lab", label: "Journals", icon: "file-text", note: "Entries, lines and controlled reversals" },
          { href: "/dev/design-lab", label: "Reconciliation", icon: "git-branch", note: "Match bank lines to records" },
          { href: "/dev/design-lab", label: "Approvals", icon: "gavel", note: "Decisions waiting on an authority" },
          { href: "/dev/design-lab", label: "Cash forecast", icon: "trending-up", note: "Projected position over 90 days" },
          { href: "/dev/design-lab", label: "Trial balance", icon: "table", note: "Debits and credits by account" },
        ].map((item, i) => (
          <Link key={i} href={item.href} className="node-card">
            <span className="node-card-ico" aria-hidden="true">
              <Icon name={item.icon} size={17} strokeWidth={1.6} />
            </span>
            <span className="node-card-text">
              <span className="node-card-title">{item.label}</span>
              <span className="node-card-note">{item.note}</span>
            </span>
            <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
          </Link>
        ))}
      </div>

      <Section title="Degraded read" meta="what the same screen says when a source fails" />
      <div className="centre">
        <div className="centre-summary card pad-lg">
          <ConditionInstrument segments={LAB_SEGMENTS} degraded label="Today" />
        </div>
        <div className="card">
          <StateNote kind="partial" title="Some data sources failed to load">
            customer_invoices, capacity_snapshots did not return. Figures on this screen may be
            incomplete — this is a system problem, not a clean bill of health. It has been reported to
            monitoring.
          </StateNote>
          <div className="mt-3">
            <Facts
              items={[
                { k: "Sources checked", v: "9", numeric: true },
                { k: "Sources returned", v: "7", numeric: true },
                { k: "All-clear possible", v: "No — a partial read cannot say" },
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}
