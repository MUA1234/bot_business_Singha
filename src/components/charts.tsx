/**
 * Singha chart primitives — pure server-rendered SVG, no dependencies, token-driven colors.
 *
 * Dataviz rules applied here (see the design method):
 *  - form follows the data's job: bars = magnitude across ordered categories; area line = change
 *    over time; horizontal bars = per-person magnitude with a state accent;
 *  - ONE hue for magnitude (the brand accent); the reserved STATUS palette (ok/warn/danger) is used
 *    only where the category genuinely IS a state (overdue age, over/under allocation) and always
 *    with a text label — never color alone;
 *  - thin marks with rounded DATA ends (rounded at the value end only, flat at the baseline),
 *    2px lines, ≥8px markers, recessive axes; values wear text tokens, never the series color;
 *  - single-series charts carry no legend (the title names the series); every mark has a native
 *    <title> tooltip; numbers are preformatted decimal strings (money stays exact upstream).
 */
import { dec } from "@/lib/money";

export interface BarDatum {
  label: string;
  /** Preformatted display value (e.g. "LKR 14,500.00") for tooltip + direct label. */
  display: string;
  /** Numeric magnitude for scaling ONLY (display strings stay exact). */
  value: number;
  /** Optional reserved-status accent; default is the brand hue. */
  tone?: "accent" | "ok" | "warn" | "danger" | "info" | "dim";
}

const TONE: Record<NonNullable<BarDatum["tone"]>, string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  info: "var(--info)",
  dim: "rgba(255,255,255,0.28)",
};

/** Bar rounded at the data end only (flat baseline), for vertical bars. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}
function rightRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y + h} Z`;
}

/** Vertical bars: magnitude across a few ordered categories. Labels under, values on top of max bars. */
export function BarChart({ data, height = 150, valueOnAll = false }: { data: BarDatum[]; height?: number; valueOnAll?: boolean }) {
  const W = 560;
  const padB = 22;
  const padT = 18;
  const plotH = height - padB - padT;
  const max = Math.max(1e-9, ...data.map((d) => d.value));
  const n = data.length || 1;
  const slot = W / n;
  const barW = Math.min(34, slot * 0.5);
  const maxIdx = data.reduce((mi, d, i) => (d.value > (data[mi]?.value ?? 0) ? i : mi), 0);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="bar chart" style={{ display: "block" }}>
      <line x1="0" y1={height - padB + 0.5} x2={W} y2={height - padB + 0.5} stroke="rgba(255,255,255,0.12)" />
      {data.map((d, i) => {
        const h = Math.max(d.value > 0 ? 3 : 0, (d.value / max) * plotH);
        const x = i * slot + (slot - barW) / 2;
        const y = height - padB - h;
        return (
          <g key={d.label}>
            {h > 0 && <path d={topRoundedRect(x, y, barW, h, 4)} fill={TONE[d.tone ?? "accent"]} opacity={d.tone ? 1 : 0.9} />}
            <title>{`${d.label}: ${d.display}`}</title>
            {(valueOnAll || i === maxIdx) && d.value > 0 && (
              <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text-muted)">
                {d.display}
              </text>
            )}
            <text x={i * slot + slot / 2} y={height - 7} textAnchor="middle" fontSize="10.5" fill="var(--text-dim)">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal bars: one row per entity (e.g. per person), label left, value right, state tone. */
export function HBarChart({ data, rowHeight = 30 }: { data: BarDatum[]; rowHeight?: number }) {
  const W = 560;
  const labelW = 150;
  const valueW = 90;
  const plotW = W - labelW - valueW;
  const H = data.length * rowHeight + 4;
  const max = Math.max(1e-9, ...data.map((d) => d.value));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="horizontal bar chart" style={{ display: "block" }}>
      {data.map((d, i) => {
        const w = Math.max(d.value > 0 ? 3 : 0, (d.value / max) * plotW);
        const y = i * rowHeight + (rowHeight - 12) / 2;
        return (
          <g key={d.label}>
            <text x={labelW - 10} y={y + 10} textAnchor="end" fontSize="11" fill="var(--text-muted)">
              {d.label.length > 20 ? d.label.slice(0, 19) + "…" : d.label}
            </text>
            <rect x={labelW} y={y} width={plotW} height={12} rx={4} fill="rgba(255,255,255,0.05)" />
            {w > 0 && <path d={rightRoundedRect(labelW, y, w, 12, 4)} fill={TONE[d.tone ?? "accent"]} />}
            <title>{`${d.label}: ${d.display}`}</title>
            <text x={labelW + plotW + 8} y={y + 10} fontSize="11" fontWeight="700" fill="var(--text-muted)">
              {d.display}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export interface LinePoint {
  /** ISO date or short label for ticks/tooltips. */
  label: string;
  value: number;
  display: string;
}

/**
 * Area line: one series over time (cash forecast). 2px line, soft fill, zero line when the range
 * crosses it, and a ≥8px marker + label on the LOWEST point (the risk moment).
 */
export function AreaLineChart({ points, height = 170 }: { points: LinePoint[]; height?: number }) {
  const W = 560;
  const padB = 20;
  const padT = 14;
  const plotH = height - padB - padT;
  if (points.length < 2) return <div className="dim small">Not enough data to chart.</div>;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const span = max - min || 1;
  const padX = 8; // keeps the trough marker + end labels inside the viewBox
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - 2 * padX);
  const y = (v: number) => padT + (1 - (v - min) / span) * plotH;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(points.length - 1)},${y(min)} L${x(0)},${y(min)} Z`;
  const lowIdx = vals.indexOf(Math.min(...vals));
  const low = points[lowIdx]!;
  const zeroY = y(0);
  const lowLabelAnchor = lowIdx < points.length / 4 ? "start" : lowIdx > (3 * points.length) / 4 ? "end" : "middle";
  const lowLabelX = Math.min(W - 4, Math.max(4, x(lowIdx)));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="area line chart" style={{ display: "block" }}>
      <defs>
        <linearGradient id="alc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {min < 0 && max > 0 && (
        <g>
          <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" />
          <text x={W - 4} y={zeroY - 5} textAnchor="end" fontSize="10" fill="var(--text-dim)">0</text>
        </g>
      )}
      <path d={area} fill="url(#alc-fill)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(lowIdx)} cy={y(low.value)} r="4.5" fill={low.value < 0 ? "var(--danger)" : "var(--accent)"} stroke="var(--bg-1)" strokeWidth="2" />
      <title>{`Lowest: ${low.display} (${low.label})`}</title>
      <text x={lowLabelX} y={Math.max(12, y(low.value) - 9)} textAnchor={lowLabelAnchor} fontSize="11" fontWeight="700"
        fill={low.value < 0 ? "var(--danger)" : "var(--text-muted)"}>
        {`low ${low.display}`}
      </text>
      <text x="0" y={height - 5} fontSize="10.5" fill="var(--text-dim)">{points[0]!.label}</text>
      <text x={W} y={height - 5} textAnchor="end" fontSize="10.5" fill="var(--text-dim)">{points[points.length - 1]!.label}</text>
    </svg>
  );
}

/** Map an AgingResult's buckets to chart data. Age IS a state: older overdue debt escalates tone. */
export function agingBars(
  buckets: Record<string, string>,
  fmt: (v: string) => string,
): BarDatum[] {
  const order: Array<{ key: string; label: string; tone: BarDatum["tone"] }> = [
    { key: "current", label: "Current", tone: "accent" },
    { key: "d1_30", label: "1–30d", tone: "accent" },
    { key: "d31_60", label: "31–60d", tone: "warn" },
    { key: "d61_90", label: "61–90d", tone: "warn" },
    { key: "d90_plus", label: "90d+", tone: "danger" },
  ];
  return order.map(({ key, label, tone }) => {
    const raw = buckets[key] ?? "0";
    return { label, display: fmt(raw), value: dec(raw).toNumber(), tone };
  });
}
