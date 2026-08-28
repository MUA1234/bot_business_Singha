import Link from "next/link";
import { Icon } from "@/components/Icon";
import {
  Facts,
  PageHead,
  Provenance,
  Section,
  Signal,
  SpatialTimeline,
  StateNote,
} from "@/components/os/primitives";
import { Badge, Button, EmptyState, FormField, Skeleton } from "@/components/ui";
import { LAB_TIMELINE } from "../fixtures";

/**
 * Every component state the system must handle, on one page.
 *
 * A beautiful failure state is a requirement, not a nicety: an operator who
 * cannot tell "there is nothing" from "we could not look" will act on the wrong
 * belief. Each state below says which of those two it is.
 */
export default function StatesLabPage() {
  return (
    <>
      <PageHead
        eyebrow="Design lab"
        title="States"
        lede="Loading, empty, success, warning, error, retry, offline, permission denied, configuration required, manual review, blocked, missing data, partial data and integration unavailable."
        actions={
          <Link href="/dev/design-lab" className="btn ghost sm">
            <Icon name="chevron-left" size={14} /> Back to the lab
          </Link>
        }
      />

      <Section title="Honest states" meta="each says what it knows and what it does not" />
      <div className="grid cols-2">
        <StateNote kind="empty" title="Nothing here yet">
          No records exist for this scope. This is a confirmed empty result, not a failed read.
        </StateNote>
        <StateNote kind="partial" title="Partial data — no all-clear can be given">
          Two of five sources failed. The absence of exceptions below does not mean there are none.
        </StateNote>
        <StateNote kind="error" title="This did not load" action={<Button variant="ghost" size="sm">Try again</Button>}>
          The request failed. Nothing was changed, and retrying is safe.
        </StateNote>
        <StateNote kind="offline" title="You are offline">
          Showing the last data this device received. Nothing you change is sent until the connection
          returns — it is queued, not lost.
        </StateNote>
        <StateNote kind="denied" title="You do not have authority for this">
          This action needs the finance approval capability. Ask an administrator to grant it. The
          record itself is unchanged and still readable.
        </StateNote>
        <StateNote kind="config" title="Integration not configured">
          This surface needs an integration that is not configured in this environment. Everything
          else on the screen is unaffected.
        </StateNote>
        <StateNote kind="review" title="Held for manual review">
          Flagged as a possible duplicate. It has NOT been processed and will not be until a person
          decides.
        </StateNote>
        <StateNote kind="blocked" title="Blocked — waiting on someone else">
          This cannot progress until the external confirmation arrives. It is not late through
          inaction.
        </StateNote>
      </div>

      <Section title="Loading" meta="a skeleton, never a spinner over stale numbers" />
      <div className="card">
        <div className="skeleton-table">
          {[0, 1, 2, 3].map((i) => (
            <div className="skeleton-row" key={i}>
              <Skeleton className="grow" />
              <Skeleton />
              <Skeleton />
            </div>
          ))}
        </div>
      </div>

      <Section title="Empty state" />
      <div className="card">
        <EmptyState
          title="No quotations yet"
          description="Quotations raised from a customer conversation will appear here with their status and their evidence."
          icon="file-text"
        />
      </div>

      <Section title="Controls" meta="every variant, every state" />
      <div className="card stack gap-3">
        <div className="row wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
        </div>
        <hr className="mat-divider" />
        <div className="grid cols-2">
          <FormField name="lab-a" label="Normal field" placeholder="Type here" />
          <FormField name="lab-b" label="With a hint" placeholder="0.00" hint="Amounts are exact — no rounding is applied on entry." />
          <FormField name="lab-c" label="Invalid" placeholder="Required" error="This field is required." />
          <FormField name="lab-d" label="Disabled" placeholder="Not editable" disabled />
        </div>
        <hr className="mat-divider" />
        <div className="row wrap gap-2">
          <Badge>default</Badge>
          <Badge variant="ok">approved</Badge>
          <Badge variant="warn">at risk</Badge>
          <Badge variant="danger">overdue</Badge>
          <Badge variant="info">informational</Badge>
          <Badge variant="accent">accent</Badge>
        </div>
      </div>

      <Section title="Dense operational data" meta="a table stays a table" />
      <div className="card">
        <p className="small muted" style={{ marginBottom: "var(--sp-3)" }}>
          Accounting, ledgers, reconciliation and any long list stay a proper 2D table: alignable,
          scannable and sortable. Depth is expressed by the surface it sits on, never by tilting
          rows. Wide tables scroll inside their own container — the page never scrolls sideways.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Counterparty</th>
                <th>Due</th>
                <th className="num">Amount</th>
                <th className="num">Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr className="is-critical">
                <td className="mono">SB-2041</td>
                <td>Placeholder Supplier (Pvt) Ltd</td>
                <td>14 days ago</td>
                <td className="num">1,840,000.00</td>
                <td className="num">1,840,000.00</td>
                <td><Badge variant="danger">overdue</Badge></td>
              </tr>
              <tr className="is-priority">
                <td className="mono">SB-2044</td>
                <td>Placeholder Traders</td>
                <td>in 2 days</td>
                <td className="num">312,500.00</td>
                <td className="num">312,500.00</td>
                <td><Badge variant="warn">due soon</Badge></td>
              </tr>
              <tr>
                <td className="mono">SB-2048</td>
                <td>Placeholder Services</td>
                <td>in 21 days</td>
                <td className="num">96,000.00</td>
                <td className="num">48,000.00</td>
                <td><Badge>part settled</Badge></td>
              </tr>
              <tr>
                <td className="mono">SB-2052</td>
                <td>Placeholder Logistics</td>
                <td>in 30 days</td>
                <td className="num">204,750.00</td>
                <td className="num">204,750.00</td>
                <td><Badge variant="ok">on time</Badge></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Section title="The record as facts" />
      <div className="card">
        <Facts
          items={[
            { k: "Reference", v: "SB-2041" },
            { k: "Counterparty", v: "Placeholder Supplier (Pvt) Ltd" },
            { k: "Amount", v: "LKR 1,840,000.00", numeric: true },
            { k: "Outstanding", v: "LKR 1,840,000.00", numeric: true },
            { k: "Due", v: "Overdue by 14 days" },
            { k: "Purchase order", v: "PO-0188" },
            { k: "Bank account", v: "", missing: true },
            { k: "Approved by", v: "", missing: true },
          ]}
        />
      </div>

      <Section title="Provenance and signals together" />
      <div className="grid cols-2">
        <div className="card stack gap-3">
          <div className="row wrap gap-3">
            <Signal kind="ok">On track</Signal>
            <Signal kind="warn">At risk</Signal>
            <Signal kind="critical">Critical</Signal>
          </div>
          <div className="row wrap gap-3">
            <Signal kind="info">Informational</Signal>
            <Signal kind="blocked">Blocked</Signal>
            <Signal kind="offline">Offline</Signal>
          </div>
        </div>
        <div className="card">
          <Provenance kind="ai" label="AI advice · confidence 0.61">
            <p className="small muted">
              Low confidence is shown as a number, not hidden. A reader deciding whether to act on
              advice needs to know how sure the system is — and that it is advice.
            </p>
          </Provenance>
        </div>
      </div>

      <Section title="Spatial timeline" />
      <div className="card pad-lg">
        <SpatialTimeline items={LAB_TIMELINE} />
      </div>
    </>
  );
}
