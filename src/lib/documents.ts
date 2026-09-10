/**
 * Document / evidence storage (Architecture V2 change plan — evidence & storage).
 * Files live in a PRIVATE Supabase Storage bucket ("evidence"); a `documents` row
 * records metadata + a content hash for dedup. Company-scoped; the object path is
 * prefixed by company_id. Downloads use short-lived signed URLs (never public).
 */
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { supabaseReadClient, supabaseWriteClient } from "@/lib/supabase/read";

export const EVIDENCE_BUCKET = "evidence";

/** Deterministic, sanitised object path. Pure. */
export function evidenceObjectPath(companyId: string, contentHash: string, filename: string): string {
  const safe = (filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  return `${companyId}/${contentHash.slice(0, 16)}-${safe}`;
}

export interface UploadResult {
  ok: boolean;
  documentId?: string;
  reason?: string;
}

/** Upload a file to the evidence bucket and record a documents row (dedup on hash). */
export async function uploadEvidenceFile(companyId: string, file: File, createdBy: string): Promise<UploadResult> {
  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) return { ok: false, reason: "no file" };
  if (file.size > 15 * 1024 * 1024) return { ok: false, reason: "file too large (15MB max)" };

  const bytes = Buffer.from(await file.arrayBuffer());
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  // Documents table reads/writes go through the RLS write client; storage bucket uploads
  // still require the service role until an authenticated storage policy is configured.
  const table = supabaseWriteClient();
  const storage = supabaseAdmin();

  // Dedup: same bytes in the same company reuse the existing document.
  const { data: existing } = await table.from("documents").select("id").eq("company_id", companyId).eq("content_hash", contentHash).maybeSingle();
  if (existing) return { ok: true, documentId: existing.id };

  const path = evidenceObjectPath(companyId, contentHash, file.name);
  const up = await storage.storage.from(EVIDENCE_BUCKET).upload(path, bytes, { contentType: file.type || "application/octet-stream", upsert: true });
  if (up.error) return { ok: false, reason: `storage: ${up.error.message} (create a private "${EVIDENCE_BUCKET}" bucket)` };

  const { data: doc, error } = await table.from("documents").insert({
    company_id: companyId, storage_path: path, mime_type: file.type || null, byte_size: file.size,
    content_hash: contentHash, scanned_status: "pending", created_by: createdBy,
  }).select("id").maybeSingle();
  if (error || !doc) return { ok: false, reason: error?.message ?? "could not record document" };
  return { ok: true, documentId: doc.id };
}

/** A short-lived signed URL for a stored object, or null. */
export async function signedEvidenceUrl(storagePath: string, expiresSeconds = 300): Promise<string | null> {
  try {
    const { data } = await supabaseReadClient().storage.from(EVIDENCE_BUCKET).createSignedUrl(storagePath, expiresSeconds);
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}
