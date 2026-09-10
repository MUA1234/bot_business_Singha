"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";

/**
 * The AI Management Room.
 *
 * When the AI is engaged the application partially recedes and this workspace
 * moves forward — a room, not a chat drawer. It always knows which screen it
 * was opened from, so the user never has to paste context into a prompt.
 *
 * HONESTY IS THE DESIGN CONSTRAINT HERE. This room only offers what the system
 * can actually do:
 *
 *   - The business-analysis pipeline is real, permission-checked and audited
 *     (`/app/command/analyze`), so the room routes to it and says what it does:
 *     observe, propose, capture low-risk tasks, and flag anything sensitive for
 *     a human with the required authority.
 *
 *   - Context questions are links into real screens with real queries behind
 *     them. Asking "which payments need attention" opens the approvals queue —
 *     it does not synthesise an answer.
 *
 *   - Where the AI gateway is not configured, the room says so and shows what
 *     is still available, rather than presenting a chat box that will fail.
 *
 * It never presents the AI as authorising anything. Every route out of this
 * room that touches money, people or commitments lands on a screen where a
 * named human authority is required.
 */
export interface AiSuggestion {
  label: string;
  detail: string;
  href: string;
  icon: string;
}

export function AIManagementRoom({
  open,
  onClose,
  contextLabel,
  contextHref,
  suggestions,
  canAnalyse,
  aiConfigured,
}: {
  open: boolean;
  onClose: () => void;
  contextLabel: string;
  contextHref: string;
  suggestions: AiSuggestion[];
  canAnalyse: boolean;
  aiConfigured: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button, a, input, textarea")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      // Focus stays in the room while it is the focused layer.
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="airoom-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="airoom"
        role="dialog"
        aria-modal="true"
        aria-label="AI Management Room"
        ref={panelRef}
      >
        <header className="airoom-head">
          <span className="presence-core" aria-hidden="true" style={{ width: 28, height: 28 }} />
          <div className="stack" style={{ minWidth: 0, flex: 1 }}>
            <span className="t-label">Senior AI Manager</span>
            <span className="airoom-context" title={contextLabel}>
              <Icon name="eye" size={11} aria-hidden="true" />
              Viewing: {contextLabel}
            </span>
          </div>
          <button
            type="button"
            className="strip-btn"
            onClick={onClose}
            aria-label="Close the AI Management Room"
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="airoom-body">
          {/* What the AI is, and what it is not — stated once, at the top, in
           * the room where a person is most likely to over-trust it. */}
          <div className="prov prov-ai" style={{ marginBottom: "var(--sp-5)" }}>
            <span className="prov-label">
              <Icon name="sparkles" size={11} /> AI advice
            </span>
            <p className="muted" style={{ marginTop: 6, fontSize: "var(--t-data)" }}>
              The AI Manager observes, explains and proposes. It never approves a payment, posts a
              journal, changes a permission or makes a commitment on your behalf. Anything it
              proposes that touches money, people or obligations is routed to the person holding the
              required authority.
            </p>
          </div>

          <div className="sec">
            <span className="sec-title">Where this screen can take you</span>
            <span className="sec-rule" />
          </div>

          {suggestions.length === 0 ? (
            <div className="state-note" data-state="partial">
              <Icon name="info" size={16} className="state-mark" />
              <div>
                <strong className="state-note-title">No context routes for this screen yet</strong>
                This screen is not yet mapped to AI context routes. Everything on it remains fully
                available; use the command palette to move elsewhere.
              </div>
            </div>
          ) : (
            <div className="stack gap-1">
              {suggestions.map((s) => (
                <Link key={s.href} href={s.href} className="matter" onClick={onClose}>
                  <div className="matter-head">
                    <div style={{ minWidth: 0 }}>
                      <span className="matter-kind">
                        <Icon name={s.icon} size={11} aria-hidden="true" /> {s.label}
                      </span>
                      <div className="matter-title" style={{ marginTop: 4 }}>
                        {s.detail}
                      </div>
                    </div>
                    <Icon name="arrow-up-right" size={16} className="dim" aria-hidden="true" />
                  </div>
                </Link>
              ))}
            </div>
          )}

          <div className="sec">
            <span className="sec-title">Structured analysis</span>
            <span className="sec-rule" />
          </div>

          {!aiConfigured ? (
            <div className="state-note" data-state="config">
              <Icon name="plug" size={16} className="state-mark" />
              <div>
                <strong className="state-note-title">AI gateway not configured</strong>
                Structured analysis needs the AI gateway to be configured in this environment. Every
                other surface in the application is unaffected and fully operational.
              </div>
            </div>
          ) : !canAnalyse ? (
            <div className="state-note" data-state="denied">
              <Icon name="lock" size={16} className="state-mark" />
              <div>
                <strong className="state-note-title">Analysis requires owner authority</strong>
                The business-analysis pipeline captures tasks and raises management cases, so it is
                restricted to the owner/administrator role. Ask an administrator to run it.
              </div>
            </div>
          ) : (
            <Link href="/app/command/analyze" className="matter" onClick={onClose}>
              <div className="matter-head">
                <div style={{ minWidth: 0 }}>
                  <span className="matter-kind">
                    <Icon name="radar" size={11} aria-hidden="true" /> Analyse a business update
                  </span>
                  <div className="matter-title" style={{ marginTop: 4 }}>
                    Extract confirmed facts, inferences, required authority and proposed work from an
                    update — with the evidence and confidence recorded against every conclusion.
                  </div>
                </div>
                <Icon name="arrow-up-right" size={16} className="dim" aria-hidden="true" />
              </div>
              <div className="matter-facts">
                <div className="matter-fact">
                  <span className="k">Creates</span>
                  <span className="v">Low-risk captured tasks only</span>
                </div>
                <div className="matter-fact">
                  <span className="k">Sensitive matters</span>
                  <span className="v">Flagged for human approval</span>
                </div>
                <div className="matter-fact">
                  <span className="k">Recorded</span>
                  <span className="v">Model, cost, confidence, evidence</span>
                </div>
              </div>
            </Link>
          )}
        </div>

        <footer className="airoom-foot">
          <Link href={contextHref} className="btn ghost block" onClick={onClose}>
            <Icon name="corner-down-left" size={15} /> Back to {contextLabel}
          </Link>
        </footer>
      </div>
    </div>
  );
}
