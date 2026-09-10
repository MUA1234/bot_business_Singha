import { fmtNumber } from "@/lib/format";

/**
 * The condition instrument — the signature object of the Command Centre.
 *
 * A layered radial composition: a machined face, a graduated outer track, and
 * one arc per condition band. The centre states today's overall operating
 * condition in words derived from the counts, not from a score.
 *
 * WHAT IT IS NOT: it is not a health score, a gauge with an invented needle
 * position, or a percentage of anything. Every arc length is
 * `segment.count / total` of the real records behind it, every number is a row
 * count, and a band with nothing in it renders as an empty arc rather than a
 * decorative minimum. When no records exist at all the instrument says so.
 *
 * `degraded` is load-bearing: when a data source failed, the instrument refuses
 * to state a condition, because a partial read cannot distinguish "nothing is
 * wrong" from "we could not see what is wrong".
 */
export type ConditionTone = "critical" | "warn" | "info" | "ok" | "blocked" | "neutral";

export interface ConditionSegment {
  key: string;
  label: string;
  count: number;
  tone: ConditionTone;
  /** Where clicking this segment or legend row takes the reader. */
  href?: string;
}

const TONE_VAR: Record<ConditionTone, string> = {
  critical: "var(--danger)",
  warn: "var(--warn)",
  info: "var(--info)",
  ok: "var(--ok)",
  blocked: "var(--blocked)",
  neutral: "var(--graphite)",
};

/**
 * Emphasis, not decoration. A ring where every band shouts equally is a rainbow
 * chart: the eye lands on whichever segment happens to be largest rather than
 * on whichever matters most. Severity therefore drives opacity as well as hue,
 * so "22 on track" recedes and "3 critical" reads first even though the healthy
 * band is seven times longer.
 */
const TONE_EMPHASIS: Record<ConditionTone, number> = {
  critical: 1,
  warn: 0.9,
  blocked: 0.62,
  info: 0.55,
  ok: 0.42,
  neutral: 0.4,
};

/** The words in the centre, chosen deterministically from the counts. */
export function conditionSummary(
  segments: ConditionSegment[],
  degraded: boolean,
): { state: string; tone: ConditionTone; note: string } {
  if (degraded) {
    return {
      state: "Condition unknown",
      tone: "warn",
      note: "One or more sources failed to load. No all-clear can be given.",
    };
  }
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total === 0) {
    return {
      state: "Nothing outstanding",
      tone: "ok",
      note: "No open exceptions across the sources checked.",
    };
  }
  const critical = segments.filter((s) => s.tone === "critical").reduce((s, x) => s + x.count, 0);
  const warn = segments.filter((s) => s.tone === "warn").reduce((s, x) => s + x.count, 0);
  if (critical > 0) {
    return {
      state: critical === 1 ? "1 critical matter" : `${fmtNumber(critical)} critical matters`,
      tone: "critical",
      note: "Critical matters are listed first below.",
    };
  }
  if (warn > 0) {
    return {
      state: warn === 1 ? "1 matter at risk" : `${fmtNumber(warn)} matters at risk`,
      tone: "warn",
      note: "Nothing critical; these need a decision today.",
    };
  }
  return { state: "On track", tone: "ok", note: "Open items are informational only." };
}

export function ConditionInstrument({
  segments,
  degraded = false,
  label = "Today",
  activeKey,
}: {
  segments: ConditionSegment[];
  degraded?: boolean;
  label?: string;
  activeKey?: string;
}) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  // Everything that is not "on track" is something a person may have to look
  // at. This is the number the centre states.
  const attention = segments
    .filter((s) => s.tone !== "ok" && s.tone !== "neutral")
    .reduce((s, x) => s + x.count, 0);
  const summary = conditionSummary(segments, degraded);

  // Geometry. The ring occupies 300° with a 30° gap at the bottom, so the eye
  // has a start and an end rather than an unbroken circle.
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const r = 84;
  const circumference = 2 * Math.PI * r;
  const sweep = 0.833; // 300° of 360°
  const usable = circumference * sweep;
  const gapBetween = total > 0 ? Math.min(4, usable / Math.max(segments.length, 1) / 6) : 0;
  const drawable = Math.max(0, usable - gapBetween * Math.max(segments.length - 1, 0));

  let offset = 0;
  const arcs = segments.map((seg) => {
    const share = total > 0 ? seg.count / total : 0;
    const length = drawable * share;
    const arc = { seg, dash: length, start: offset };
    offset += length + gapBetween;
    return arc;
  });

  // Graduations — a machined face has marks. 24 minor, every 6th major. The
  // arc runs from 120° to 420°, so its 60° gap sits centred at the bottom.
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const angle = 120 + (i * 300) / 23;
    const rad = (angle * Math.PI) / 180;
    const inner = i % 6 === 0 ? r + 10 : r + 12;
    const outer = r + 16;
    return {
      key: i,
      major: i % 6 === 0,
      x1: cx + Math.cos(rad) * inner,
      y1: cy + Math.sin(rad) * inner,
      x2: cx + Math.cos(rad) * outer,
      y2: cy + Math.sin(rad) * outer,
    };
  });

  return (
    <div className="stack gap-3">
      <div className="instr">
        <div className="instr-face" aria-hidden="true" />
        <svg
          className="instr-svg"
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={
            degraded
              ? "Operating condition unknown because one or more data sources failed to load"
              : total === 0
                ? "No outstanding matters"
                : `Operating condition: ${summary.state}. ${segments
                    .filter((s) => s.count > 0)
                    .map((s) => `${s.label}: ${s.count}`)
                    .join(", ")}`
          }
        >
          <g transform={`rotate(120 ${cx} ${cy})`}>
            <circle
              className="instr-track"
              cx={cx}
              cy={cy}
              r={r}
              strokeWidth={7}
              strokeDasharray={`${usable} ${circumference}`}
            />
            {arcs.map(({ seg, dash, start }) =>
              dash > 0.5 ? (
                <circle
                  key={seg.key}
                  className={`instr-arc${activeKey && activeKey !== seg.key ? " is-dim" : ""}`}
                  cx={cx}
                  cy={cy}
                  r={r}
                  // The most severe band is also the thickest, so severity is
                  // carried by weight as well as by hue and opacity.
                  strokeWidth={seg.tone === "critical" ? 9 : 7}
                  stroke={TONE_VAR[seg.tone]}
                  // `color` carries the same tone so the CSS glow
                  // (`drop-shadow(... currentColor)`) can never light this arc
                  // in a colour that disagrees with the status it represents.
                  style={{ color: TONE_VAR[seg.tone] }}
                  strokeOpacity={TONE_EMPHASIS[seg.tone]}
                  strokeDasharray={`${dash} ${circumference}`}
                  strokeDashoffset={-start}
                />
              ) : null,
            )}
          </g>
          {ticks.map((t) => (
            <line
              key={t.key}
              className={`instr-tick${t.major ? " is-major" : ""}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
            />
          ))}
        </svg>
        <div className="instr-core">
          <span className="instr-core-label">{label}</span>
          {/* The headline number is what NEEDS ATTENTION, not the total of
           * everything charted. A large total that is mostly healthy reads as
           * alarming; the healthy band belongs in the ring for context and in
           * the line beneath for scale. */}
          <span className="instr-core-value t-numeric">
            {degraded ? "—" : fmtNumber(attention)}
          </span>
          <span className="instr-core-state" style={{ color: TONE_VAR[summary.tone] }}>
            {summary.state}
          </span>
        </div>
      </div>

      {/* The caption sits BELOW the dial, on the full width of the column. Held
       * inside the circle it wrapped to four lines against the narrowing face
       * and crowded the figure it describes. It is never shortened — a caption
       * that silently drops half its sentence is worse than one that is long. */}
      <p className="instr-core-note">
        {degraded ? summary.note : `of ${fmtNumber(total)} tracked · ${summary.note}`}
      </p>

      <div className="instr-legend">
        {segments.map((seg) => {
          const Row = seg.href ? "a" : "div";
          return (
            <Row
              key={seg.key}
              {...(seg.href ? { href: seg.href } : {})}
              className="instr-legend-row"
              aria-current={activeKey === seg.key ? "true" : undefined}
            >
              <span
                className="mark"
                style={{ background: TONE_VAR[seg.tone], opacity: TONE_EMPHASIS[seg.tone] }}
                aria-hidden="true"
              />
              <span className="name">{seg.label}</span>
              <span className={`count${seg.count === 0 ? " is-zero" : ""}`}>
                {fmtNumber(seg.count)}
              </span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
