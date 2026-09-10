import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";

/**
 * Spatial Executive OS primitives.
 *
 * Small, pure, presentational pieces that let a screen be composed from
 * typography, depth and grouping instead of from a wall of cards. None of them
 * fetches anything; all of them are safe in a server component.
 */

/* ── PAGE HEAD ─────────────────────────────────────────────────────────── */
export function PageHead({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {lede && <p className="page-lede">{lede}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/* ── SECTION ───────────────────────────────────────────────────────────── */
export function Section({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="sec">
      <span className="sec-title">{title}</span>
      <span className="sec-rule" />
      {meta && <span className="sec-meta">{meta}</span>}
    </div>
  );
}

/* ── SIGNAL ────────────────────────────────────────────────────────────────
 * Status is a glyph + a colour + a word. Never colour alone: this renders a
 * shape-differentiated marker AND the label, so it survives greyscale, colour
 * blindness and a screen reader. */
export type SignalKind = "ok" | "warn" | "critical" | "info" | "offline" | "blocked";

export function Signal({ kind, children }: { kind: SignalKind; children: ReactNode }) {
  return (
    <span className={`sig sig-${kind}`}>
      <span className="sig-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/* ── PROVENANCE ────────────────────────────────────────────────────────────
 * AI advice, deterministic system state, a human decision, an approved action
 * and a completed action must never look alike. This is the one component that
 * enforces that distinction, so it cannot drift screen by screen. */
export type ProvenanceKind = "ai" | "system" | "human" | "approved" | "done";

const PROV_LABEL: Record<ProvenanceKind, { text: string; icon: string }> = {
  ai: { text: "AI advice", icon: "sparkles" },
  system: { text: "System state", icon: "database" },
  human: { text: "Human decision", icon: "user-round" },
  approved: { text: "Approved", icon: "check-circle" },
  done: { text: "Completed", icon: "check-circle-2" },
};

export function Provenance({
  kind,
  label,
  children,
}: {
  kind: ProvenanceKind;
  /** Override the standard label, e.g. "AI recommendation · confidence 0.72". */
  label?: ReactNode;
  children: ReactNode;
}) {
  const spec = PROV_LABEL[kind];
  return (
    <div className={`prov prov-${kind}`}>
      <span className="prov-label">
        <Icon name={spec.icon} size={11} aria-hidden="true" />
        {label ?? spec.text}
      </span>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

/* ── HONEST STATE ──────────────────────────────────────────────────────────
 * Loading, empty, error, offline, permission denied, configuration required,
 * manual review, blocked, missing data, partial data, integration unavailable.
 * Beautiful failure states are a requirement, not a nicety — and a state note
 * never claims a condition the system has not established. */
export type StateKind =
  | "denied"
  | "offline"
  | "error"
  | "config"
  | "partial"
  | "review"
  | "blocked"
  | "empty";

const STATE_ICON: Record<StateKind, string> = {
  denied: "lock",
  offline: "wifi-off",
  error: "alert-triangle",
  config: "plug",
  partial: "alert-circle",
  review: "eye",
  blocked: "timer",
  empty: "info",
};

export function StateNote({
  kind,
  title,
  children,
  action,
}: {
  kind: StateKind;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state-note" data-state={kind}>
      <Icon name={STATE_ICON[kind]} size={16} className="state-mark" aria-hidden="true" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <strong className="state-note-title">{title}</strong>
        {children}
        {action && <div style={{ marginTop: "var(--sp-3)" }}>{action}</div>}
      </div>
    </div>
  );
}

/* ── FACTS ─────────────────────────────────────────────────────────────────
 * A record laid out as facts rather than as a read-only form. A fact with no
 * value says so explicitly — an empty cell is indistinguishable from a zero. */
export interface FactItem {
  k: string;
  v: ReactNode;
  numeric?: boolean;
  missing?: boolean;
}

export function Facts({ items }: { items: FactItem[] }) {
  return (
    <div className="facts">
      {items.map((f) => (
        <div className="fact" key={f.k}>
          <span className="k">{f.k}</span>
          <span
            className={`v${f.numeric ? " is-numeric" : ""}${f.missing ? " is-missing" : ""}`}
          >
            {f.missing ? "not recorded" : f.v}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── PROVENANCE TAG — measured / inferred / missing ────────────────────────
 * An operational figure must say where it came from. A number with no
 * provenance is not evidence, and telemetry is never invented. */
export function ProvenanceTag({ kind }: { kind: "measured" | "inferred" | "missing" }) {
  return (
    <span className="provenance-tag" data-kind={kind}>
      {kind}
    </span>
  );
}

/* ── MATTER ────────────────────────────────────────────────────────────────
 * A priority item as a spatial object. Its band comes from the record — a due
 * date, an approval threshold, a blocked state — never from a preference. */
export type MatterBand = "critical" | "high" | "normal" | "done";

export function Matter({
  kind,
  kindIcon,
  title,
  value,
  valueTone,
  band = "normal",
  facts,
  href,
  footer,
  arriving = false,
}: {
  kind: string;
  kindIcon?: string;
  title: ReactNode;
  value?: ReactNode;
  valueTone?: "critical" | "warn" | "ok" | "accent";
  band?: MatterBand;
  facts?: FactItem[];
  href?: string;
  footer?: ReactNode;
  arriving?: boolean;
}) {
  const toneVar =
    valueTone === "critical"
      ? "var(--danger)"
      : valueTone === "warn"
        ? "var(--warn)"
        : valueTone === "ok"
          ? "var(--ok)"
          : valueTone === "accent"
            ? "var(--accent)"
            : "var(--ivory)";

  const body = (
    <>
      <div className="matter-head">
        <div style={{ minWidth: 0 }}>
          <span className="matter-kind">
            {kindIcon && <Icon name={kindIcon} size={11} aria-hidden="true" />} {kind}
          </span>
          <div className="matter-title" style={{ marginTop: 4 }}>
            {title}
          </div>
        </div>
        {href && <Icon name="arrow-up-right" size={16} className="dim" aria-hidden="true" />}
      </div>
      {value !== undefined && (
        <div className="matter-value t-numeric" style={{ color: toneVar }}>
          {value}
        </div>
      )}
      {facts && facts.length > 0 && (
        <div className="matter-facts">
          {facts.map((f) => (
            <div className="matter-fact" key={f.k}>
              <span className="k">{f.k}</span>
              <span className="v">{f.missing ? "not recorded" : f.v}</span>
            </div>
          ))}
        </div>
      )}
      {footer && <div className="matter-foot">{footer}</div>}
    </>
  );

  const className = `matter${arriving ? " is-arriving" : ""}`;

  if (href) {
    return (
      <Link href={href} className={className} data-band={band}>
        {body}
      </Link>
    );
  }
  return (
    <div className={className} data-band={band}>
      {body}
    </div>
  );
}

/* ── CHANGE LEDGER ─────────────────────────────────────────────────────────
 * "What changed?" — a vertical spine of real deltas. Every entry is a row that
 * moved; nothing here is generated commentary. */
export interface ChangeItem {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  when?: string;
  tone: "critical" | "warn" | "ok" | "info";
  href?: string;
}

export function ChangeLedger({ items, since }: { items: ChangeItem[]; since: string }) {
  if (items.length === 0) {
    return (
      <StateNote kind="empty" title={`Nothing changed since ${since}`}>
        No record in the sources checked moved into or out of an exception state in this window.
      </StateNote>
    );
  }
  return (
    <div className="changes">
      {items.map((item) => {
        const inner = (
          <>
            <span className="change-node" aria-hidden="true">
              <i />
            </span>
            <span className="change-text">
              <span className="change-title">{item.title}</span>
              {item.meta && <span className="change-meta">{item.meta}</span>}
            </span>
            {item.when && <span className="change-when">{item.when}</span>}
          </>
        );
        const cls = `change is-${item.tone}`;
        return item.href ? (
          <Link key={item.id} href={item.href} className={cls}>
            {inner}
          </Link>
        ) : (
          <div key={item.id} className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/* ── EXECUTIVE BRIEFING ────────────────────────────────────────────────────
 * Grouped by what the reader must DO, not by which subsystem produced it. */
export type BriefBand = "act" | "decide" | "watch" | "opportunity" | "clear";

export const BRIEF_BAND_LABEL: Record<BriefBand, string> = {
  act: "Act now",
  decide: "Decide today",
  watch: "Watch",
  opportunity: "Opportunities",
  clear: "No action required",
};

export interface BriefItem {
  id: string;
  band: BriefBand;
  title: ReactNode;
  detail?: ReactNode;
  href?: string;
  /** Where this conclusion came from — never omitted for AI-derived lines. */
  provenance?: ProvenanceKind;
}

export function ExecutiveBriefing({ items }: { items: BriefItem[] }) {
  const bands: BriefBand[] = ["act", "decide", "watch", "opportunity", "clear"];
  const populated = bands
    .map((band) => ({ band, items: items.filter((i) => i.band === band) }))
    .filter((g) => g.items.length > 0);

  if (populated.length === 0) {
    return (
      <StateNote kind="empty" title="No briefing items">
        Nothing in the sources checked requires attention, a decision or watching.
      </StateNote>
    );
  }

  return (
    <div className="brief-groups">
      {populated.map((group) => (
        <section className="brief-group" data-band={group.band} key={group.band}>
          <div className="brief-group-head">
            <span className="brief-group-name">{BRIEF_BAND_LABEL[group.band]}</span>
            <span className="brief-group-count">{group.items.length}</span>
          </div>
          <div className="brief-items">
            {group.items.map((item) => {
              const inner = (
                <>
                  <span className="change-node" aria-hidden="true">
                    <i />
                  </span>
                  <span className="change-text">
                    <span className="change-title">{item.title}</span>
                    {item.detail && <span className="change-meta">{item.detail}</span>}
                  </span>
                  {item.href && (
                    <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
                  )}
                </>
              );
              const tone =
                group.band === "act"
                  ? "is-critical"
                  : group.band === "decide"
                    ? "is-warn"
                    : group.band === "clear"
                      ? "is-ok"
                      : "is-info";
              const node = item.href ? (
                <Link key={item.id} href={item.href} className={`change ${tone}`}>
                  {inner}
                </Link>
              ) : (
                <div key={item.id} className={`change ${tone}`}>
                  {inner}
                </div>
              );
              // An AI-derived line always carries its provenance rule, so it can
              // never be read as a fact the system holds.
              return item.provenance === "ai" ? (
                <div className="prov prov-ai" key={item.id} style={{ paddingLeft: "var(--sp-3)" }}>
                  {node}
                </div>
              ) : (
                node
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── CONSTELLATION ─────────────────────────────────────────────────────────
 * A spatial grouping of records by a real dimension. It is a layout, not a
 * chart: every node is a record and opens that record. */
export interface ConstellationNode {
  id: string;
  label: string;
  meta?: string;
  band?: "critical" | "high" | "blocked" | "normal" | "done";
  href?: string;
  icon?: string;
}

export interface Cluster {
  key: string;
  name: string;
  nodes: ConstellationNode[];
}

export function Constellation({ clusters }: { clusters: Cluster[] }) {
  const populated = clusters.filter((c) => c.nodes.length > 0);
  if (populated.length === 0) {
    return (
      <StateNote kind="empty" title="Nothing to group">
        No records match the current scope, so there is nothing to arrange.
      </StateNote>
    );
  }
  return (
    <div className="constellation">
      {populated.map((cluster) => (
        <section className="cluster" key={cluster.key}>
          <div className="cluster-head">
            <span className="cluster-name">{cluster.name}</span>
            <span className="cluster-count">{cluster.nodes.length}</span>
            <span className="cluster-rule" />
          </div>
          <div className="cluster-nodes">
            {cluster.nodes.map((node) => {
              const inner = (
                <>
                  {node.icon && <Icon name={node.icon} size={13} aria-hidden="true" />}
                  <span className="node-label">{node.label}</span>
                  {node.meta && <span className="node-meta">{node.meta}</span>}
                </>
              );
              return node.href ? (
                <Link key={node.id} href={node.href} className="node" data-band={node.band ?? "normal"}>
                  {inner}
                </Link>
              ) : (
                <span key={node.id} className="node" data-band={node.band ?? "normal"}>
                  {inner}
                </span>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── SPATIAL TIMELINE ──────────────────────────────────────────────────────
 * Past recedes, the current point is prominent, the future extends forward. */
export interface TimelineItem {
  id: string;
  when: string;
  title: ReactNode;
  body?: ReactNode;
  position: "past" | "current" | "future";
  href?: string;
}

export function SpatialTimeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <StateNote kind="empty" title="No milestones recorded">
        Nothing has been scheduled or recorded on this timeline yet.
      </StateNote>
    );
  }
  return (
    <div className="timeline">
      {items.map((item) => (
        <div className="tl-item" data-when={item.position} key={item.id}>
          <span className="tl-node" aria-hidden="true">
            <i />
          </span>
          <div className="tl-when">{item.when}</div>
          <div className="tl-title">
            {item.href ? <Link href={item.href}>{item.title}</Link> : item.title}
          </div>
          {item.body && <div className="tl-body">{item.body}</div>}
        </div>
      ))}
    </div>
  );
}

/* ── AUTHORITY NOTICE ──────────────────────────────────────────────────────
 * States plainly that a named human authority must act. It is never styled as
 * a suggestion, and never sits adjacent to an AI action control. */
export function AuthorityNotice({ children }: { children: ReactNode }) {
  return (
    <div className="authority-notice">
      <Icon name="gavel" size={16} className="authority-mark" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/* ── CONSEQUENCE ───────────────────────────────────────────────────────────
 * What a decision actually does, in one figure and one sentence, at a size
 * that cannot be skimmed past. */
export function Consequence({
  value,
  tone,
  children,
}: {
  value: ReactNode;
  tone?: "critical" | "warn" | "ok";
  children: ReactNode;
}) {
  const color =
    tone === "critical"
      ? "var(--danger)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "ok"
          ? "var(--ok)"
          : "var(--ivory)";
  return (
    <div className="consequence">
      <span className="consequence-value" style={{ color }}>
        {value}
      </span>
      <span className="consequence-text">{children}</span>
    </div>
  );
}
