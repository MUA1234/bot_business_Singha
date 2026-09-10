"use client";

/**
 * R2D — the Ask-AI spatial window.
 *
 * Operational guidance inside the management workspace, not a chat app. What the interface must
 * carry is not the answer text — it is everything around the answer that lets a person judge it:
 * where it came from, how confident it is, what is missing, what still needs approval, and whether
 * what they just typed was saved somewhere a manager can read.
 *
 * The manager-visibility notice appears BEFORE submission. Telling someone afterwards that their
 * question became a reviewable work record is not disclosure.
 */

import { useCallback, useRef, useState } from "react";
import type { WindowContentProps } from "../types";

type Language = "en" | "si" | "ta";

interface Citation {
  sourceTable: string;
  sourceId: string;
  claimLabel?: string;
}

interface SuggestedAction {
  actionId: string;
  rationale?: string;
  requiresApproval: boolean;
}

interface Answer {
  answer: string;
  language: Language;
  citations: Citation[];
  confidence: number;
  uncertainties: string[];
  missingInformation: string[];
  suggestedActions: SuggestedAction[];
  requiredApproval: string | null;
  escalation: string | null;
  refusalReason: string | null;
  staleEvidence: boolean;
}

interface AskResponse {
  ok: boolean;
  mode?: "ordinary" | "sensitive" | "unverified";
  answer?: Answer;
  persisted?: boolean;
  notice?: string;
  languageFellBack?: boolean;
  managerVisibility?: string;
  error?: string;
}

interface Turn {
  question: string;
  response: AskResponse;
}

const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  si: "සිංහල",
  ta: "தமிழ்",
};

/** Words rather than a bare number: "0.62" invites false precision. */
function confidenceLabel(c: number): { text: string; tone: string } {
  if (c >= 0.75) return { text: "High confidence", tone: "text-emerald-700 dark:text-emerald-400" };
  if (c >= 0.4) return { text: "Moderate confidence", tone: "text-amber-700 dark:text-amber-400" };
  return { text: "Low confidence", tone: "text-rose-700 dark:text-rose-400" };
}

export default function AskAiWindow(_props: WindowContentProps) {
  const [question, setQuestion] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ask-ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, language }),
      });
      const body = (await res.json()) as AskResponse;
      if (!res.ok || !body.ok) {
        setError(body.error === "rate_limited"
          ? "Please wait a moment before asking again."
          : "That could not be answered. Nothing was changed.");
      } else {
        setTurns((t) => [...t, { question: q, response: body }]);
        setQuestion("");
      }
    } catch {
      setError("The guidance service could not be reached. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }, [question, language, busy]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      {/* Disclosure BEFORE the input, not after the answer. */}
      <p
        id="ask-ai-disclosure"
        className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
        role="note"
      >
        Operational guidance is a company work record. Managers with the review capability may read
        it for supervision, quality and audit. For anything personal — a grievance, your health, or
        a confidential matter — speak to HR directly instead.
      </p>

      <div
        ref={liveRef}
        aria-live="polite"
        aria-atomic="false"
        className="flex flex-col gap-4"
      >
        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} />
        ))}
        {turns.length === 0 && (
          <p className="text-slate-600 dark:text-slate-400">
            Ask about your authorised work — what needs attention, why something is overdue, what
            approval a step requires, or what evidence is missing.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 p-3 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      )}

      <form
        className="mt-auto flex flex-col gap-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className="flex items-center gap-2">
          <label htmlFor="ask-ai-language" className="text-xs text-slate-600 dark:text-slate-400">
            Answer in
          </label>
          <select
            id="ask-ai-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            className="min-h-[48px] rounded-md border border-slate-300 bg-white px-3 dark:border-slate-600 dark:bg-slate-900"
          >
            {(Object.keys(LANGUAGE_LABELS) as Language[]).map((l) => (
              <option key={l} value={l}>{LANGUAGE_LABELS[l]}</option>
            ))}
          </select>
        </div>

        <label htmlFor="ask-ai-question" className="sr-only">Your question</label>
        <textarea
          id="ask-ai-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Keyboard-only operation throughout.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
          rows={3}
          maxLength={2000}
          aria-describedby="ask-ai-disclosure"
          placeholder="What needs my attention today?"
          className="w-full rounded-md border border-slate-300 p-3 dark:border-slate-600 dark:bg-slate-900"
        />
        <button
          type="submit"
          disabled={busy || question.trim().length === 0}
          className="min-h-[48px] min-w-[48px] rounded-md bg-slate-900 px-4 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const { response } = turn;
  const a = response.answer;

  return (
    <article className="flex flex-col gap-2 border-b border-slate-200 pb-4 dark:border-slate-700">
      <p className="font-medium text-slate-900 dark:text-slate-100">{turn.question}</p>

      {a && <p className="whitespace-pre-wrap text-slate-800 dark:text-slate-200">{a.answer}</p>}

      {/* Why the answer was not kept, or where to take it. */}
      {response.notice && (
        <p className="rounded-md bg-slate-100 p-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {response.notice}
        </p>
      )}

      {a && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={confidenceLabel(a.confidence).tone}>
            {confidenceLabel(a.confidence).text}
          </span>
          {a.staleEvidence && (
            <span className="text-amber-700 dark:text-amber-400">
              Based on evidence that may be out of date
            </span>
          )}
          {response.languageFellBack && (
            <span className="text-slate-600 dark:text-slate-400">
              Answered in English — no language preference was available
            </span>
          )}
          {response.persisted === false && (
            <span className="text-slate-600 dark:text-slate-400">Not saved to your history</span>
          )}
        </div>
      )}

      {a && a.citations.length > 0 && (
        <details className="text-xs">
          <summary className="min-h-[48px] cursor-pointer py-3 text-slate-700 dark:text-slate-300">
            Evidence ({a.citations.length})
          </summary>
          <ul className="ml-4 list-disc">
            {a.citations.map((c, i) => (
              <li key={i} className="py-1 text-slate-700 dark:text-slate-300">
                <code>{c.sourceTable}</code> · {c.claimLabel ?? "supporting record"}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Absence of evidence stated as absence — never as reassurance. */}
      {a && a.missingInformation.length > 0 && (
        <div className="text-xs text-slate-700 dark:text-slate-300">
          <p className="font-medium">Missing information</p>
          <ul className="ml-4 list-disc">
            {a.missingInformation.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}

      {a && a.uncertainties.length > 0 && (
        <div className="text-xs text-slate-700 dark:text-slate-300">
          <p className="font-medium">Not certain about</p>
          <ul className="ml-4 list-disc">
            {a.uncertainties.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </div>
      )}

      {a && a.suggestedActions.length > 0 && (
        <div className="rounded-md border border-slate-300 p-2 text-xs dark:border-slate-600">
          <p className="font-medium text-slate-900 dark:text-slate-100">Suggested next steps</p>
          <ul className="mt-1 flex flex-col gap-2">
            {a.suggestedActions.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <code className="text-slate-700 dark:text-slate-300">{s.actionId}</code>
                {/* Unambiguous: nothing here has happened, and nothing here can be triggered. */}
                <span className="rounded bg-slate-200 px-2 py-1 text-slate-800 dark:bg-slate-700 dark:text-slate-200">
                  Suggestion only — review required
                </span>
                {s.requiresApproval && (
                  <span className="text-amber-700 dark:text-amber-400">Needs approval</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {a && a.requiredApproval && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Approval required: {a.requiredApproval}
        </p>
      )}

      {a && a.refusalReason && (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          No answer was given ({a.refusalReason}). Nothing was changed.
        </p>
      )}
    </article>
  );
}
