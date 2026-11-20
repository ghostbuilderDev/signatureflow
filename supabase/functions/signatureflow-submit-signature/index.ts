import * as lib from "npm:pdf-lib@1.17.1";
import { stampPdf, pngBytes } from "../_shared/pdf-tools.mjs";
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
    if (!fields?.length) throw new HttpError("Aucune zone configurée");
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
          user_agent: req.headers.get("user-agent")?.slice(0, 300),
          request_id: requestId,
        },
      }),
    );
    const { data: download } = await admin.storage
      .from("signatureflow-documents")
      .createSignedUrl(uploadedPath, 900);
    return json({
      ok: true,
      sha256: finalHash,
      downloadUrl: download?.signedUrl,
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
