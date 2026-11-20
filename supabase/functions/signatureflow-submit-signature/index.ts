import * as lib from "npm:pdf-lib@1.17.1";
import { stampPdf, pngBytes } from "../_shared/pdf-tools.mjs";
import { sendSignedPdf } from "../_shared/email.ts";
import {
  corsHeaders,
  json,
  adminClient,
  sha256Text,
  sha256Bytes,
  validToken,
  body,
  checked,
  HttpError,
  failure,
} from "../_shared/common.ts";

const emailOk = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const pdfFilename = (name: string) =>
  `${name.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "document"}-signe.pdf`;

async function deliverAutomaticCopies(
  admin: ReturnType<typeof adminClient>,
  doc: Record<string, unknown>,
  signer: Record<string, unknown>,
  pdf: Uint8Array,
) {
  const mode = String(doc.completion_mode || "manual");
  if (mode === "manual") return { sent: 0, failed: 0, skipped: 0 };
  const allSigners =
      checked(
        await admin
          .from("signatureflow_signers")
          .select("id,name,email")
          .eq("document_id", doc.id)
          .order("signing_order"),
      ) || [],
    signerEmails = new Set(
      allSigners.map((person: { email: string }) => person.email.toLowerCase()),
    ),
    extra = Array.isArray(doc.completion_recipients)
      ? doc.completion_recipients
          .map((email: unknown) => String(email).trim().toLowerCase())
          .filter(emailOk)
      : [],
    deliveries: Array<{
      email: string;
      name?: string;
      type: "acknowledgement_copy" | "final_copy";
      final: boolean;
      signerId?: string;
    }> = [];
  if (mode === "signer_after_each") {
    deliveries.push({
      email: String(signer.email).toLowerCase(),
      name: String(signer.name),
      type: "acknowledgement_copy",
      final: false,
      signerId: String(signer.id),
    });
    if (doc.status === "signed")
      for (const email of extra.filter((value: string) => !signerEmails.has(value)))
        deliveries.push({ email, type: "final_copy", final: true });
  } else if (mode === "all_after_complete" && doc.status === "signed") {
    for (const person of allSigners)
      deliveries.push({
        email: person.email.toLowerCase(),
        name: person.name,
        type: "final_copy",
        final: true,
        signerId: person.id,
      });
    for (const email of extra.filter((value: string) => !signerEmails.has(value)))
      deliveries.push({ email, type: "final_copy", final: true });
  }
  const unique = [
    ...new Map(
      deliveries.map((item) => [`${item.type}:${item.email}`, item]),
    ).values(),
  ];
  let sent = 0,
    failed = 0,
    skipped = 0;
  for (const item of unique) {
    const deliveryKey = `${item.type}:${doc.id}:${item.email}`,
      existing = checked(
        await admin
          .from("signatureflow_deliveries")
          .select("status")
          .eq("delivery_key", deliveryKey)
          .maybeSingle(),
      );
    if (existing?.status === "sent") {
      skipped++;
      continue;
    }
    checked(
      await admin.from("signatureflow_deliveries").upsert({
        delivery_key: deliveryKey,
        document_id: doc.id,
        signer_id: item.signerId || null,
        recipient_email: item.email,
        delivery_type: item.type,
        status: "pending",
        error: null,
        updated_at: new Date().toISOString(),
      }),
    );
    try {
      const providerId = await sendSignedPdf({
        to: item.email,
        recipientName: item.name,
        documentName: String(doc.name),
        pdf,
        filename: pdfFilename(String(doc.name)),
        final: item.final,
      });
      checked(
        await admin
          .from("signatureflow_deliveries")
          .update({
            status: "sent",
            provider_id: providerId,
            error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("delivery_key", deliveryKey),
      );
      checked(
        await admin.from("signatureflow_audit_events").insert({
          document_id: doc.id,
          signer_id: item.signerId || null,
          event_type: "completion_copy_sent",
          metadata: { recipient: item.email, delivery_type: item.type },
        }),
      );
      if (item.signerId)
        await admin
          .from("signatureflow_signers")
          .update({ copy_sent_at: new Date().toISOString() })
          .eq("id", item.signerId);
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Échec de l’envoi";
      await admin
        .from("signatureflow_deliveries")
        .update({
          status: "error",
          error: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("delivery_key", deliveryKey);
      await admin.from("signatureflow_audit_events").insert({
        document_id: doc.id,
        signer_id: item.signerId || null,
        event_type: "completion_email_error",
        metadata: {
          recipient: item.email,
          delivery_type: item.type,
          error: message.slice(0, 500),
        },
      });
      failed++;
    }
  }
  if (
    doc.status === "signed" &&
    failed === 0 &&
    unique.some((item) => item.final)
  )
    await admin
      .from("signatureflow_documents")
      .update({ completion_sent_at: new Date().toISOString() })
      .eq("id", doc.id);
  return { sent, failed, skipped };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  let admin,
    claim,
    lease,
    uploadedPath,
    committing = false;
  try {
    const {
      token,
      typedName,
      accepted,
      signatureDataUrl,
      initialsDataUrl,
      values = {},
      readPages = [],
      requestId,
      expectedSha256,
    } = await body(req);
    validToken(token);
    if (
      typeof typedName !== "string" ||
      typedName.trim().length < 2 ||
      typedName.length > 160 ||
      accepted !== true ||
      !/^[-a-f0-9]{36}$/.test(requestId || "") ||
      !/^[a-f0-9]{64}$/.test(expectedSha256 || "")
    )
      throw new HttpError(
        "Nom, consentement et version du document obligatoires",
      );
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.keys(values).length > 500
    )
      throw new HttpError("Champs invalides");
    const signature = pngBytes(signatureDataUrl),
      initials = initialsDataUrl ? pngBytes(initialsDataUrl) : null;
    admin = adminClient();
    lease = crypto.randomUUID();
    claim = checked(
      await admin.rpc("signatureflow_claim", {
        p_hash: await sha256Text(token),
        p_request: requestId,
        p_lease: lease,
        p_expected: expectedSha256,
      }),
    );
    if (claim.alreadySigned)
      return json({ ok: true, alreadySigned: true, sha256: claim.sha256 });
    const { document: doc, signer, fields } = claim;
    if (typedName.trim() !== String(signer.name).trim())
      throw new HttpError(
        "L’identité du signataire ne correspond pas au lien personnel.",
      );
    if (!fields?.length) throw new HttpError("Aucune zone configurée");
    const read = new Set(
      Array.isArray(readPages)
        ? readPages.filter(
            (page) => Number.isInteger(page) && page >= 1 && page <= doc.page_count,
          )
        : [],
    );
    if (doc.require_full_read && read.size !== doc.page_count)
      throw new HttpError(
        `Consultez les ${doc.page_count} pages du document avant de signer.`,
      );
    const blob = checked(
      await admin.storage
        .from("signatureflow-documents")
        .download(doc.current_storage_path),
    );
    if (!blob) throw new HttpError("PDF indisponible", 404);
    const source = new Uint8Array(await blob.arrayBuffer()),
      sourceHash = await sha256Bytes(source);
    if (sourceHash !== expectedSha256)
      throw new HttpError(
        "Intégrité du PDF non vérifiée. Contactez l’émetteur.",
        409,
      );
    const pdf = await lib.PDFDocument.load(source),
      signedAt = new Date();
    const final = await stampPdf(
      pdf,
      fields,
      {
        signature,
        initials,
        typedName: typedName.trim(),
        role: signer.role || "",
        identityStamp: doc.identity_stamp !== false,
        signedAt,
        values,
        email: signer.email,
      },
      lib,
    );
    const finalHash = await sha256Bytes(final);
    uploadedPath = `${doc.owner_id}/${doc.id}/signed-${lease}.pdf`;
    checked(
      await admin.storage
        .from("signatureflow-documents")
        .upload(uploadedPath, final, {
          contentType: "application/pdf",
          upsert: false,
        }),
    );
    // If the commit response is lost, retain the immutable PDF: a retry detects signed status.
    committing = true;
    checked(
      await admin.rpc("signatureflow_finish", {
        p_document: doc.id,
        p_signer: signer.id,
        p_lease: lease,
        p_path: uploadedPath,
        p_source: sourceHash,
        p_final: finalHash,
        p_name: typedName.trim(),
        p_signed_at: signedAt.toISOString(),
        p_metadata: {
          email: signer.email,
          consent: true,
          field_ids: fields.map((f: { id: string }) => f.id),
          values,
          read_pages: [...read].sort((a, b) => a - b),
          full_document_read: !doc.require_full_read || read.size === doc.page_count,
          user_agent: req.headers.get("user-agent")?.slice(0, 300),
          request_id: requestId,
        },
      }),
    );
    const completedDoc = checked(
        await admin
          .from("signatureflow_documents")
          .select("*")
          .eq("id", doc.id)
          .single(),
      ),
      delivery = await deliverAutomaticCopies(
        admin,
        completedDoc,
        signer,
        final,
      );
    const { data: download } = await admin.storage
      .from("signatureflow-documents")
      .createSignedUrl(uploadedPath, 900);
    return json({
      ok: true,
      sha256: finalHash,
      downloadUrl: download?.signedUrl,
      delivery,
    });
  } catch (e) {
    if (admin && claim?.document && lease) {
      await admin.rpc("signatureflow_release", {
        p_document: claim.document.id,
        p_signer: claim.signer.id,
        p_lease: lease,
      });
      if (uploadedPath && !committing)
        await admin.storage
          .from("signatureflow-documents")
          .remove([uploadedPath]);
    }
    return failure(e);
  }
});
