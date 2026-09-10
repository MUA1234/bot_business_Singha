/**
 * The honesty guarantees of the Spatial Executive OS instruments.
 *
 * The design brief allows a cinematic surface but forbids a dishonest one. The
 * three rules these tests defend are the ones a beautiful screen is most likely
 * to break:
 *
 *   1. A DEGRADED READ NEVER PRODUCES AN ALL-CLEAR. "Nothing is wrong" and "we
 *      could not see what is wrong" must never render the same.
 *   2. NOTHING IS INVENTED. A change ledger entry, a calendar placement and a
 *      briefing line each correspond to a real record; a record with no date is
 *      reported as undated rather than guessed onto a day.
 *   3. EVERY DERIVATION IS DETERMINISTIC. The same inputs produce the same
 *      output and the same order, so two people looking at the same data see
 *      the same thing.
 */
import { describe, it, expect } from "vitest";
import { conditionSummary, type ConditionSegment } from "@/components/os/ConditionInstrument";
import { buildBandedBriefing } from "@/management/ai-manager/briefing-bands";
import { buildChanges } from "@/management/ai-manager/changes";
import { buildCommitmentCalendar } from "@/modules/calendar/commitments";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const iso = (offsetDays: number) =>
  new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("condition instrument — a degraded read never reports all-clear", () => {
  const clear: ConditionSegment[] = [
    { key: "critical", label: "Critical", count: 0, tone: "critical" },
    { key: "ok", label: "On track", count: 12, tone: "ok" },
  ];

  it("says on track only when every source was read", () => {
    const s = conditionSummary(clear, false);
    expect(s.tone).toBe("ok");
    expect(s.state).toBe("On track");
  });

  it("refuses to state a condition when a source failed", () => {
    const s = conditionSummary(clear, true);
    expect(s.state).toBe("Condition unknown");
    expect(s.tone).not.toBe("ok");
    expect(s.note.toLowerCase()).toContain("no all-clear");
  });

  it("distinguishes an empty result from a failed one", () => {
    const empty = conditionSummary([], false);
    expect(empty.state).toBe("Nothing outstanding");
    const failed = conditionSummary([], true);
    expect(failed.state).toBe("Condition unknown");
    expect(empty.state).not.toBe(failed.state);
  });

  it("leads with the most severe band that has records", () => {
    const mixed: ConditionSegment[] = [
      { key: "c", label: "Critical", count: 2, tone: "critical" },
      { key: "w", label: "Warn", count: 9, tone: "warn" },
      { key: "o", label: "On track", count: 40, tone: "ok" },
    ];
    expect(conditionSummary(mixed, false).tone).toBe("critical");
    const warnOnly = mixed.map((s) => (s.tone === "critical" ? { ...s, count: 0 } : s));
    expect(conditionSummary(warnOnly, false).tone).toBe("warn");
  });
});

describe("banded briefing", () => {
  const base = {
    criticalCount: 0,
    warnCount: 0,
    currency: "LKR",
    cash: "1000.00",
    arOverdue: "0",
    apOverdue: "0",
  };

  it("gives an all-clear only on a complete read", () => {
    const clean = buildBandedBriefing(base, false);
    expect(clean.some((i) => i.band === "clear")).toBe(true);

    const degraded = buildBandedBriefing(base, true);
    expect(degraded.some((i) => i.band === "clear")).toBe(false);
    expect(degraded[0]!.band).toBe("act");
    expect(degraded[0]!.title.toLowerCase()).toContain("failed to load");
  });

  it("bands by what the reader must do, not by subsystem", () => {
    const items = buildBandedBriefing(
      { ...base, criticalCount: 2, warnCount: 1, apOverdue: "500.00" },
      false,
    );
    expect(items.find((i) => i.id === "critical")!.band).toBe("act");
    expect(items.find((i) => i.id === "ap-overdue")!.band).toBe("decide");
    expect(items.find((i) => i.id === "warnings")!.band).toBe("watch");
  });

  it("marks every deterministic line as system state, never as AI advice", () => {
    const items = buildBandedBriefing({ ...base, criticalCount: 1 }, false);
    expect(items.every((i) => i.provenance === "system")).toBe(true);
  });

  it("is deterministic", () => {
    const a = buildBandedBriefing({ ...base, criticalCount: 3, apOverdue: "9.00" }, false);
    const b = buildBandedBriefing({ ...base, criticalCount: 3, apOverdue: "9.00" }, false);
    expect(a).toEqual(b);
  });
});

describe("change ledger — every entry is a record that moved", () => {
  it("reports a due date crossing only inside the window", () => {
    const inWindow = buildChanges({
      tasks: [{ id: "t1", title: "A", status: "in_progress", due_date: iso(-1) }],
      now: NOW,
    });
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]!.title).toContain("passed its due date");

    const longPast = buildChanges({
      tasks: [{ id: "t1", title: "A", status: "in_progress", due_date: iso(-30) }],
      now: NOW,
    });
    expect(longPast).toHaveLength(0);
  });

  it("never claims a terminal task became overdue", () => {
    const out = buildChanges({
      tasks: [
        { id: "t1", title: "Done", status: "completed", due_date: iso(-1), updated_at: NOW.toISOString() },
      ],
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("A task was completed");
  });

  it("says nothing at all when nothing moved", () => {
    const out = buildChanges({
      tasks: [{ id: "t1", title: "Quiet", status: "in_progress", due_date: iso(30) }],
      receivables: [{ label: "x", dueDate: iso(30) }],
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("summarises routine progress instead of listing every touched row", () => {
    // A day of ordinary work touches many rows. Listing each one as "work
    // updated" buries the two entries that matter, so only states that mean
    // something to a reader are listed; the rest are counted.
    const touched = (id: string, status: string) => ({
      id,
      title: `Task ${id}`,
      status,
      updated_at: NOW.toISOString(),
    });
    const out = buildChanges({
      tasks: [
        touched("a", "planned"),
        touched("b", "scheduled"),
        touched("c", "captured"),
        touched("d", "in_progress"),
        touched("e", "blocked"),
      ],
      now: NOW,
    });

    const titles = out.map((e) => e.title);
    expect(titles).toContain("A task is now blocked");
    expect(titles).toContain("Work started");
    // planned / scheduled / captured are routine and are counted, not listed.
    expect(out.find((e) => e.id === "quiet")?.title).toBe("3 other records were updated");
    expect(titles.filter((t) => t.startsWith("Work updated"))).toHaveLength(0);
  });

  it("omits the routine summary entirely when nothing routine moved", () => {
    const out = buildChanges({
      tasks: [{ id: "a", title: "A", status: "blocked", updated_at: NOW.toISOString() }],
      now: NOW,
    });
    expect(out.some((e) => e.id === "quiet")).toBe(false);
  });

  it("orders most severe first and is deterministic", () => {
    const input = {
      tasks: [
        { id: "b", title: "B", status: "in_progress", updated_at: NOW.toISOString() },
        { id: "a", title: "A", status: "blocked", updated_at: NOW.toISOString() },
      ],
      payables: [{ id: "p1", label: "bill", dueDate: iso(-1) }],
      now: NOW,
    };
    const first = buildChanges(input);
    const second = buildChanges(input);
    expect(first).toEqual(second);
    expect(first[0]!.tone).toBe("critical");
  });
});

describe("commitment calendar — an undated record is reported, never placed", () => {
  const sources = [
    {
      kind: "task" as const,
      items: [
        { id: "with-date", date: iso(3), title: "Dated" },
        { id: "no-date", date: null, title: "Undated" },
        { id: "empty", date: "", title: "Also undated" },
      ],
    },
  ];

  it("places only dated records and counts the rest", () => {
    const c = buildCommitmentCalendar({ now: NOW, sources });
    expect(c.totalPlaced).toBe(1);
    expect(c.undated).toEqual([{ kind: "task", count: 2 }]);
    expect(c.days.flatMap((d) => d.entries).map((e) => e.title)).toEqual(["Dated"]);
  });

  it("marks a passed date overdue only when the record is still open", () => {
    const c = buildCommitmentCalendar({
      now: NOW,
      sources: [
        {
          kind: "task",
          items: [
            { id: "open", date: iso(-2), title: "Still open" },
            { id: "closed", date: iso(-2), title: "Closed", closed: true },
          ],
        },
      ],
    });
    expect(c.overdue.map((e) => e.title)).toEqual(["Still open"]);
  });

  it("respects the horizon in both directions", () => {
    const c = buildCommitmentCalendar({
      now: NOW,
      horizonDays: 5,
      lookbackDays: 5,
      sources: [
        {
          kind: "obligation",
          items: [
            { id: "near", date: iso(2), title: "Near" },
            { id: "far", date: iso(90), title: "Far" },
            { id: "ancient", date: iso(-90), title: "Ancient" },
          ],
        },
      ],
    });
    expect(c.days.flatMap((d) => d.entries).map((e) => e.title)).toEqual(["Near"]);
  });

  it("is deterministic in day and within-day order", () => {
    const input = {
      now: NOW,
      sources: [
        {
          kind: "task" as const,
          items: [
            { id: "z", date: iso(1), title: "Zulu" },
            { id: "a", date: iso(1), title: "Alpha" },
            { id: "late", date: iso(-1), title: "Late" },
          ],
        },
      ],
    };
    const a = buildCommitmentCalendar(input);
    const b = buildCommitmentCalendar(input);
    expect(a).toEqual(b);
    expect(a.days.map((d) => d.date)).toEqual([iso(-1), iso(1)]);
    expect(a.days[1]!.entries.map((e) => e.title)).toEqual(["Alpha", "Zulu"]);
  });
});
