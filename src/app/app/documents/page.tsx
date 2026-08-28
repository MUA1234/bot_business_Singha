/**
 * Documents & knowledge (§39).
 *
 * Documents in this system are EVIDENCE: a private-bucket object plus a
 * `documents` row carrying its hash, size, type and scan state. This surface
 * presents them as what they are — thin physical sheets with a stated state —
 * alongside the governing records that are themselves documents (contracts,
 * licences, insurance policies).
 *
 * Three honesty rules govern it:
 *
 *   1. Scan state is shown, never hidden. A file whose malware scan is still
 *      `pending` is labelled pending; it is not presented as clean.
 *   2. No download URL is minted on this page. Signed URLs are short-lived and
 *      are issued from the record the evidence belongs to, so a link here can
 *      never outlive its context.
 *   3. Draft, expired and unapproved states on governing documents are
 *      unmissable, because acting on an expired contract is a real exposure.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtNumber, fmtDate } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Documents — Singha Central" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return "size not recorded";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The filename at the end of the stored object path. Never a signed URL. */
function displayName(storagePath: string): string {
  const tail = storagePath.split("/").pop() ?? storagePath;
  // Paths are `<company>/<hash16>-<filename>`; show the human part.
  const dash = tail.indexOf("-");
  return dash > 0 ? tail.slice(dash + 1) : tail;
}

export default async function DocumentsPage() {
  const p = await requireProfile();
  const db = supabaseReadClient();
  const cid = p.companyId;
  const today = new Date().toISOString().slice(0, 10);

  const [docs, contracts, licences, insurances] = await Promise.all([
    rows<any>(() =>
      db
        .from("documents")
        .select("id, storage_path, mime_type, byte_size, scanned_status, created_at")
        .eq("company_id", cid)
        .order("created_at", { ascending: false })
        .limit(200) as any,
    ),
    rows<any>(() =>
      db
        .from("contracts")
        .select("id, title, renewal_date, status")
        .eq("company_id", cid)
        .order("renewal_date", { ascending: true })
        .limit(200) as any,
    ),
    rows<any>(() =>
      db
        .from("licences")
        .select("id, name, expiry_date, status")
        .eq("company_id", cid)
        .order("expiry_date", { ascending: true })
        .limit(200) as any,
    ),
    rows<any>(() =>
      db
        .from("insurances")
        .select("id, policy_name, expiry_date, status")
        .eq("company_id", cid)
        .order("expiry_date", { ascending: true })
        .limit(200) as any,
    ),
  ]);

  const pending = docs.filter((d: any) => d.scanned_status === "pending");
  const infected = docs.filter((d: any) => d.scanned_status === "infected");
  const clean = docs.filter((d: any) => d.scanned_status === "clean");

  const expiredGoverning = [
    ...licences.filter((l: any) => l.expiry_date && l.expiry_date < today),
    ...insurances.filter((i: any) => i.expiry_date && i.expiry_date < today && i.status !== "cancelled"),
    ...contracts.filter((c: any) => c.renewal_date && c.renewal_date < today),
  ];

  /** A governing document's state, from its own dates and status. */
  function governingState(date: string | null, status?: string | null): "draft" | "expired" | "unapproved" | undefined {
    if (status === "draft") return "draft";
    if (date && date < today) return "expired";
    if (status === "pending" || status === "unapproved") return "unapproved";
    return undefined;
  }

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Govern"
        title="Documents & knowledge"
        lede="Evidence files and the governing documents the business runs on. Files are held in a private store; a download link is issued from the record a file belongs to, never from a list."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/legal/contracts">Contracts</Link>
            <Link className="btn ghost sm" href="/app/legal/licences">Licences</Link>
          </>
        }
      />

      {(infected.length > 0 || expiredGoverning.length > 0) && (
        <>
          <Section title="Needs a decision" />
          <div className="field-matters">
            {infected.length > 0 && (
              <Matter
                kind="Quarantined"
                kindIcon="shield-alert"
                band="critical"
                title={`${infected.length} uploaded file${infected.length === 1 ? "" : "s"} failed a malware scan`}
                footer={<Signal kind="critical">Not downloadable — do not attempt to open</Signal>}
              />
            )}
            {expiredGoverning.length > 0 && (
              <Matter
                kind="Lapsed"
                kindIcon="alert-triangle"
                band="critical"
                title={`${expiredGoverning.length} governing document${expiredGoverning.length === 1 ? " has" : "s have"} passed its date`}
                href="/app/legal"
                footer={<Signal kind="critical">Operating on a lapsed document is an exposure</Signal>}
              />
            )}
          </div>
        </>
      )}

      <Section title="Position" />
      <div className="grid cols-4">
        <div className="card stat">
          <div className="k">Evidence files</div>
          <div className="v">{fmtNumber(docs.length)}</div>
          <div className="d">In the private evidence store</div>
        </div>
        <div className="card stat">
          <div className="k">Scanned clean</div>
          <div className="v">{fmtNumber(clean.length)}</div>
          <div className="d">
            <Signal kind="ok">Safe to open</Signal>
          </div>
        </div>
        <div className="card stat">
          <div className="k">Awaiting a scan</div>
          <div className="v">{fmtNumber(pending.length)}</div>
          <div className="d">
            {pending.length > 0 ? (
              <Signal kind="warn">Not yet cleared — this is not the same as clean</Signal>
            ) : (
              <Signal kind="ok">Nothing waiting</Signal>
            )}
          </div>
        </div>
        <div className="card stat">
          <div className="k">Governing documents</div>
          <div className="v">{fmtNumber(contracts.length + licences.length + insurances.length)}</div>
          <div className="d">Contracts, licences and policies</div>
        </div>
      </div>

      {/* ── GOVERNING DOCUMENTS AS SHEETS ───────────────────────────────── */}
      <Section title="Governing documents" meta="what the business is bound by" />
      {contracts.length + licences.length + insurances.length === 0 ? (
        <StateNote kind="empty" title="No governing documents recorded">
          Contracts, licences and insurance policies recorded in this company appear here with their
          dates and their state.
        </StateNote>
      ) : (
        <div className="grid cols-3">
          {contracts.map((c: any) => (
            <div className="sheet" data-state={governingState(c.renewal_date, c.status)} key={`c-${c.id}`}>
              <div className="sheet-head">
                <div style={{ minWidth: 0 }}>
                  <span className="sheet-kind">Contract</span>
                  <div className="sheet-title">{c.title}</div>
                </div>
              </div>
              <div className="small dim">
                {c.renewal_date ? `Renews ${fmtDate(c.renewal_date)}` : "No renewal date recorded"}
              </div>
              <div className="mt-2">
                <Link className="btn ghost sm" href={`/app/legal/contracts/${c.id}`}>
                  Open
                </Link>
              </div>
            </div>
          ))}
          {licences.map((l: any) => (
            <div className="sheet" data-state={governingState(l.expiry_date, l.status)} key={`l-${l.id}`}>
              <div className="sheet-head">
                <div style={{ minWidth: 0 }}>
                  <span className="sheet-kind">Licence</span>
                  <div className="sheet-title">{l.name}</div>
                </div>
              </div>
              <div className="small dim">
                {l.expiry_date ? `Expires ${fmtDate(l.expiry_date)}` : "No expiry recorded"}
              </div>
              <div className="mt-2">
                <Link className="btn ghost sm" href="/app/legal/licences">
                  Open
                </Link>
              </div>
            </div>
          ))}
          {insurances.map((i: any) => (
            <div className="sheet" data-state={governingState(i.expiry_date, i.status)} key={`i-${i.id}`}>
              <div className="sheet-head">
                <div style={{ minWidth: 0 }}>
                  <span className="sheet-kind">Insurance</span>
                  <div className="sheet-title">{i.policy_name}</div>
                </div>
              </div>
              <div className="small dim">
                {i.expiry_date ? `Expires ${fmtDate(i.expiry_date)}` : "No expiry recorded"}
              </div>
              <div className="mt-2">
                <Link className="btn ghost sm" href="/app/legal/insurances">
                  Open
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── EVIDENCE FILES ──────────────────────────────────────────────── */}
      <Section title="Evidence files" meta={`${docs.length} most recent`} />
      {docs.length === 0 ? (
        <StateNote kind="empty" title="No evidence files yet">
          Files uploaded against a task, an expense or a message appear here once stored. Uploading
          happens on the record the evidence belongs to, not here.
        </StateNote>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th className="num">Size</th>
                  <th>Scan state</th>
                  <th>Stored</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d: any) => (
                  <tr key={d.id} className={d.scanned_status === "infected" ? "is-critical" : undefined}>
                    <td>
                      <span className="row gap-2">
                        <Icon name="file-text" size={14} className="dim" aria-hidden="true" />
                        {/* A filename is an identifier — it truncates rather
                            than breaking mid-word, and keeps its full value
                            available on hover and to a screen reader. */}
                        <span className="filename" title={displayName(d.storage_path)}>
                          {displayName(d.storage_path)}
                        </span>
                      </span>
                    </td>
                    <td className="dim small mono">{d.mime_type ?? "not recorded"}</td>
                    <td className="num dim small">{humanSize(d.byte_size)}</td>
                    <td>
                      {d.scanned_status === "clean" ? (
                        <Signal kind="ok">clean</Signal>
                      ) : d.scanned_status === "infected" ? (
                        <Signal kind="critical">infected — quarantined</Signal>
                      ) : d.scanned_status === "skipped" ? (
                        <Signal kind="offline">scan skipped</Signal>
                      ) : (
                        <Signal kind="warn">pending</Signal>
                      )}
                    </td>
                    <td className="dim small">{fmtDate(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small dim mt-3">
            No download link is issued from this list. Open the task, expense or message the file was
            attached to; that surface mints a short-lived signed URL scoped to the reader.
          </p>
        </div>
      )}
    </div>
  );
}
