/**
 * Business analysis (§6.1/§6.2). Admin surface to run a business update through the
 * observe → validate → plan pipeline. The assistant proposes and captures tasks; it
 * never executes. Requires OPENAI_API_KEY to be configured.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { AnalyzeForm } from "./AnalyzeForm";

export const metadata = { title: "Analysis — Singha Central" };

export default async function AnalyzePage() {
  await requireAdmin();
  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Analysis</h1>
          <p className="muted mt-1">Paste a business update — it is read, follow-up tasks are captured, and anything needing authority is flagged. Nothing is executed.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command" aria-label="Back to Command Centre">← Command Centre</Link>
      </div>
      <Card>
        <AnalyzeForm />
      </Card>
    </div>
  );
}
