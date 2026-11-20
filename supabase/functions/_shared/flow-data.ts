import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  adminClient,
  requireUser,
  checked,
  HttpError,
  sha256Bytes,
} from "./common.ts";
import * as lib from "npm:pdf-lib@1.17.1";
import { validUUID, safeTitle } from "./flow-core.mjs";
export const BUCKET = "signatureflow-documents";
export async function context(req: Request) {
  const user = await requireUser(req),
    admin = adminClient();
  const scoped = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    },
  );
  return { user, admin, scoped };
}
export async function sitePermission(ctx: any, id: string, manage = false) {
  if (!validUUID(id)) throw new HttpError("Chantier invalide");
  const allowed = checked(
    await ctx.scoped.rpc(
      manage
        ? "journal_can_manage_chantier_documents"
        : "journal_can_access_chantier",
      { p_chantier_id: id },
    ),
  );
  if (allowed !== true) throw new HttpError("Accès au chantier refusé", 403);
}
export async function documentPermission(ctx: any, id: string, manage = false) {
  if (!validUUID(id)) throw new HttpError("Document invalide");
  const doc = checked(
    await ctx.admin
      .from("sf3_documents")
      .select("*")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!doc) throw new HttpError("Document introuvable", 404);
  if (doc.chantier_id) await sitePermission(ctx, doc.chantier_id, manage);
  else if (doc.owner_id !== ctx.user.id)
    throw new HttpError("Document inaccessible", 403);
  return doc;
}
export async function versionPermission(ctx: any, id: string, manage = false) {
  if (!validUUID(id)) throw new HttpError("Version invalide");
  const version = checked(
    await ctx.admin.from("sf3_versions").select("*").eq("id", id).maybeSingle(),
  );
  if (!version) throw new HttpError("Version introuvable", 404);
  return {
    version,
    doc: await documentPermission(ctx, version.document_id, manage),
  };
}
export async function bundle(admin: any, versionId: string) {
  const version = checked(
    await admin.from("sf3_versions").select("*").eq("id", versionId).single(),
  );
  const doc = checked(
    await admin
      .from("sf3_documents")
      .select("*")
      .eq("id", version.document_id)
      .single(),
  );
  const campaigns =
    checked(
      await admin
        .from("sf3_campaigns")
        .select("*")
        .eq("version_id", versionId)
        .order("created_at"),
    ) || [];
  const ids = campaigns.map((c: any) => c.id);
  const mappings = ids.length
    ? checked(
        await admin
          .from("sf3_envelopes")
          .select("*")
          .in("campaign_id", ids)
          .order("created_at"),
      ) || []
    : [];
  const eids = mappings.map((e: any) => e.envelope_id);
  const envelopes = eids.length
    ? checked(
        await admin.from("signatureflow_documents").select("*").in("id", eids),
      ) || []
    : [];
  const signers = eids.length
    ? checked(
        await admin
          .from("signatureflow_signers")
          .select(
            "id,document_id,name,email,role,status,signed_at,signing_order,token_expires_at,result_sha256",
          )
          .in("document_id", eids),
      ) || []
    : [];
  const recipients = ids.length
    ? checked(
        await admin
          .from("sf3_recipients")
          .select(
            "signer_id,envelope_id,campaign_id,user_id,company,email_status,opened_at,invited_at,last_reminded_at",
          )
          .in("campaign_id", ids),
      ) || []
    : [];
  const archives =
    checked(
      await admin
        .from("sf3_archives")
        .select("*")
        .eq("version_id", versionId)
        .order("created_at", { ascending: false }),
    ) || [];
  const linkedCSF = version.linked_csf_version_id
    ? checked(
        await admin
          .from("sf3_versions")
          .select("id,label,state")
          .eq("id", version.linked_csf_version_id)
          .single(),
      )
    : null;
  return {
    version,
    doc,
    campaigns,
    mappings,
    envelopes,
    signers,
    recipients,
    archives,
    linkedCSFStale: !!linkedCSF && linkedCSF.state !== "current",
    linkedCSF,
  };
}
export async function pdfBytes(admin: any, bucket: string, path: string) {
  const blob = checked(await admin.storage.from(bucket).download(path));
  if (!blob || blob.size > 20 * 1024 * 1024)
    throw new HttpError("PDF indisponible ou supérieur à 20 Mo");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-"))
    throw new HttpError("Fichier PDF invalide");
  return bytes;
}
export async function verifyPDF(bytes: Uint8Array) {
  const pdf = await lib.PDFDocument.load(bytes);
  const pages = pdf.getPageCount();
  if (pages < 1 || pages > 190)
    throw new HttpError("Le document doit comporter entre 1 et 190 pages.");
  return { pages, sha256: await sha256Bytes(bytes), bytes: bytes.length };
}
export async function originalMetadata(ctx: any, input: any) {
  const label = safeTitle(input.label, 60);
  const documentId = input.documentId || crypto.randomUUID(),
    versionId = crypto.randomUUID();
  let doc;
  if (input.documentId) doc = await documentPermission(ctx, documentId, true);
  else {
    if (input.chantierId) {
      await sitePermission(ctx, input.chantierId, true);
      const folder = checked(
        await ctx.admin
          .from("chantier_document_folders")
          .select("id,chantier_id")
          .eq("id", input.folderId)
          .single(),
      );
      if (folder.chantier_id !== input.chantierId)
        throw new HttpError("Dossier d’un autre chantier");
    }
    if (
      !["CSF", "ISF", "PPSPS", "PARTICULARITES", "AUTRE"].includes(
        input.documentType,
      )
    )
      throw new HttpError("Type de document invalide");
    doc = {
      id: documentId,
      owner_id: ctx.user.id,
      chantier_id: input.chantierId || null,
      folder_id: input.folderId || null,
      title: safeTitle(input.title),
      document_type: input.documentType,
    };
    checked(await ctx.admin.from("sf3_documents").insert(doc));
  }
  if (input.sourceDocumentId) {
    const source = checked(
      await ctx.admin
        .from("chantier_documents")
        .select("chantier_id,folder_id")
        .eq("id", input.sourceDocumentId)
        .single(),
    );
    if (
      source.chantier_id !== doc.chantier_id ||
      source.folder_id !== doc.folder_id
    )
      throw new HttpError(
        "Le PDF source doit appartenir au même chantier et au même dossier.",
      );
  }
  const version = {
    id: versionId,
    document_id: documentId,
    label,
    change_summary: String(input.changeSummary || "").slice(0, 2000),
    effective_at: input.effectiveAt || null,
    previous_id: doc.current_version_id || null,
    linked_csf_version_id: input.linkedCSFVersionId || null,
    source_document_id: input.sourceDocumentId || null,
    source_path: `flow/${doc.owner_id}/${versionId}/original.pdf`,
    state: "uploading",
  };
  if (version.linked_csf_version_id) {
    const linked = await versionPermission(ctx, version.linked_csf_version_id);
    if (
      linked.doc.document_type !== "CSF" ||
      linked.doc.chantier_id !== doc.chantier_id
    )
      throw new HttpError("La CSF liée doit appartenir au même chantier.");
  }
  checked(await ctx.admin.from("sf3_versions").insert(version));
  return { doc, version };
}
export async function finishUpload(ctx: any, versionId: string) {
  const { version } = await versionPermission(ctx, versionId, true);
  if (version.state !== "uploading") return version;
  const bytes = await pdfBytes(ctx.admin, BUCKET, version.source_path),
    meta = await verifyPDF(bytes);
  return checked(
    await ctx.admin
      .from("sf3_versions")
      .update({
        source_sha256: meta.sha256,
        source_pages: meta.pages,
        source_bytes: meta.bytes,
        state: "draft",
      })
      .eq("id", versionId)
      .eq("state", "uploading")
      .select("*")
      .single(),
  );
}
