import {
  encryptLink,
  authorizeFlowEnvelope,
} from "../_shared/flow-security.ts";
import * as lib from "npm:pdf-lib@1.17.1";
import { validateFields } from "../_shared/pdf-tools.mjs";
import {
  corsHeaders,
  json,
  adminClient,
  requireUser,
  randomToken,
  sha256Text,
  sha256Bytes,
  body,
  checked,
  HttpError,
  failure,
  escapeHtml as esc,
} from "../_shared/common.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  try {
    const user = await requireUser(req),
      {
        documentId,
        appUrl,
        delivery = "links",
        action,
      } = await body(req, 4096),
      admin = adminClient();
    const doc = checked(
      await admin
        .from("signatureflow_documents")
        .select("*")
        .eq("id", documentId)
        .maybeSingle(),
    );
    if (!doc || doc.owner_id !== user.id)
      throw new HttpError("Dossier inaccessible", 403);
    await authorizeFlowEnvelope(req, doc);
    if (action === "cancel") {
      checked(
        await admin.rpc("signatureflow_cancel", {
          p_document: doc.id,
          p_owner: user.id,
        }),
      );
      return json({ ok: true });
    }
    if (!["links", "email"].includes(delivery))
      throw new HttpError("Mode de partage invalide");
    // Prefer a dedicated URL over APP_URL, which may belong to Journal de Chantier.
    const base = new URL(Deno.env.get("SIGNATUREFLOW_APP_URL") || appUrl || "");
    if (base.protocol !== "https:" && base.hostname !== "localhost")
      throw new HttpError("URL HTTPS requise");
    base.search = "";
    base.hash = "";
    const resendKey = Deno.env.get("RESEND_API_KEY"),
      from =
        Deno.env.get("SIGNATUREFLOW_EMAIL_FROM") ||
        Deno.env.get("JOURNAL_CR_FROM") ||
        Deno.env.get("EMAIL_FROM");
    if (delivery === "email" && (!resendKey || !from))
      throw new HttpError(
        "L’envoi e-mail nécessite RESEND_API_KEY et SIGNATUREFLOW_EMAIL_FROM. Utilisez le partage de liens.",
        503,
      );
    const signers =
      checked(
        await admin
          .from("signatureflow_signers")
          .select("*")
          .eq("document_id", doc.id)
          .order("signing_order"),
      ) || [];
    const fields =
      checked(
        await admin
          .from("signatureflow_signature_fields")
          .select("*")
          .eq("document_id", doc.id)
          .order("id"),
      ) || [];
    const blob = checked(
      await admin.storage
        .from("signatureflow-documents")
        .download(doc.current_storage_path),
    );
    if (!blob) throw new HttpError("PDF indisponible", 404);
    if (blob.size > 20 * 1024 * 1024)
      throw new HttpError("PDF limité à 20 Mo", 413);
    const bytes = new Uint8Array(await blob.arrayBuffer()),
      pdf = await lib.PDFDocument.load(bytes);
    if (pdf.getPageCount() > 200) throw new HttpError("PDF limité à 200 pages");
    if (
      doc.status === "draft" &&
      pdf
        .getForm()
        .getFields()
        .some(
          (f) =>
            f instanceof lib.PDFSignature &&
            f.acroField.dict.has(lib.PDFName.of("V")),
        )
    )
      throw new HttpError(
        "Ce PDF contient une signature numérique. Importez un original non signé pour préserver sa validité.",
      );
    validateFields(fields, pdf.getPageCount(), signers);
    const expires = new Date(Date.now() + 14 * 86400000).toISOString();
    const links = await Promise.all(
      signers
        .filter((s) => s.status !== "signed")
        .map(async (s) => {
          const token = randomToken(),
            url = new URL(base);
          url.hash = "sign=" + token;
          return {
            id: s.id,
            name: s.name,
            email: s.email,
            role: s.role || "",
            order: s.signing_order,
            url: url.href,
            hash: await sha256Text(token),
            expires,
          };
        }),
    );
    const manifest = fields.map(
      ({ id, signer_id, page, x, y, width, height, kind, required }) => ({
        id,
        signer_id,
        page,
        x,
        y,
        width,
        height,
        kind,
        required,
      }),
    );
    checked(
      await admin.rpc(doc.sf3_managed ? "sf3_issue" : "signatureflow_issue", {
        p_document: doc.id,
        p_owner: user.id,
        p_links: links.map(({ id, hash, expires }) => ({ id, hash, expires })),
        p_hash: await sha256Bytes(bytes),
        p_pages: pdf.getPageCount(),
        p_manifest: manifest,
        ...(doc.sf3_managed
          ? {
              p_encrypted: await Promise.all(
                links.map(async (l) => ({
                  id: l.id,
                  hash: l.hash,
                  cipher: await encryptLink(l.url),
                })),
              ),
            }
          : {}),
      }),
    );
    const managedFlow = doc.sf3_managed === true;
    const results = [];
    for (const link of links) {
      let sent = false,
        error = "";
      if (delivery === "email" && !managedFlow) {
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${resendKey}`,
            },
            body: JSON.stringify({
              from,
              to: [link.email],
              subject: `Signature requise — ${doc.name}`,
              text: `Bonjour ${link.name},\nVous êtes identifié comme : ${link.role || "signataire"}.\nLe document « ${doc.name} » est à consulter et signer :\n${link.url}\nLien personnel valable 14 jours.`,
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><h2>${doc.workflow_type === "acknowledgement" ? "Document à consulter" : "Document à signer"}</h2><p>Bonjour ${esc(link.name)},</p><p>Vous êtes identifié comme : <strong>${esc(link.role || "signataire")}</strong>.</p><p>${esc(doc.name)}</p><p><a href="${esc(link.url)}">Consulter le document et signer</a></p><p>Ce lien est personnel et valable 14 jours.${doc.signing_mode === "sequential" ? " Les signatures sont recueillies dans l’ordre indiqué." : ""}</p></div>`,
            }),
          });
          sent = res.ok;
          if (!sent) error = `E-mail refusé (${res.status})`;
        } catch {
          error = "Service e-mail indisponible";
        }
      }
      checked(
        await admin.from("signatureflow_audit_events").insert({
          document_id: doc.id,
          signer_id: link.id,
          event_type: managedFlow
            ? "invitation_queued"
            : sent
              ? "invitation_sent"
              : delivery === "email"
                ? "email_error"
                : "link_created",
          metadata: { expires_at: expires, ...(error ? { error } : {}) },
        }),
      );
      results.push({
        id: link.id,
        name: link.name,
        email: link.email,
        role: link.role,
        url: link.url,
        expires,
        sent,
        error,
      });
    }
    return json({
      ok: true,
      queued: managedFlow,
      sent: results.filter((r) => r.sent).length,
      links: results,
      warning:
        "La création de ces liens remplace les précédents pour les signataires en attente.",
    });
  } catch (e) {
    return failure(e);
  }
});
