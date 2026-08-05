/**
 * Senior AI Manager — analyze (§6.1/§6.2). Admin surface to run a business update
 * through the observe → validate → plan pipeline. The AI proposes and captures tasks;
 * it never executes. Requires OPENAI_API_KEY to be configured.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { AnalyzeForm } from "./AnalyzeForm";

export const metadata = { title: "AI Manager — Singha" };

export default async function AnalyzePage() {
  await requireAdmin();
  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>AI Manager</h1>
          <p className="muted mt-1">Observe a business update → captured tasks + proposals. It never executes.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command">← Command Centre</Link>
      </div>
      <AnalyzeForm />
    </div>
  );
}
