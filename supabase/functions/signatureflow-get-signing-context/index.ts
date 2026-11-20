import {
  corsHeaders,
  json,
  adminClient,
  sha256Text,
  validToken,
  body,
  checked,
  HttpError,
  failure,
  sha256Bytes,
} from "../_shared/common.ts";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  try {
    const { token } = await body(req, 2048);
    validToken(token);
    const admin = adminClient();
    const signer = checked(
      await admin
        .from("signatureflow_signers")
        .select("*")
        .eq("token_hash", await sha256Text(token))
        .maybeSingle(),
    );
    if (
      !signer ||
      !signer.token_expires_at ||
      new Date(signer.token_expires_at) < new Date()
    )
      throw new HttpError("Lien invalide ou expiré", 410);
    const doc = checked(
      await admin
        .from("signatureflow_documents")
        .select("*")
        .eq("id", signer.document_id)
        .single(),
    );
    if (
      !doc ||
      doc.status === "cancelled" ||
      doc.status === "draft" ||
      signer.status === "cancelled"
    )
      throw new HttpError("Ce document n’est plus disponible", 410);
    const previous =
      doc.signing_mode === "sequential"
        ? checked(
            await admin
              .from("signatureflow_signers")
              .select("id")
              .eq("document_id", doc.id)
              .lt("signing_order", signer.signing_order)
              .neq("status", "signed"),
          )
        : [];
    const blocked = (previous || []).length > 0;
    const fields = checked(
      await admin
        .from("signatureflow_signature_fields")
        .select("id,page,x,y,width,height,kind,label,required")
        .eq("document_id", doc.id)
        .eq("signer_id", signer.id)
        .order("page"),
    );
    const path = doc.current_storage_path;
    const signed = checked(
      await admin.storage
        .from("signatureflow-documents")
        .createSignedUrl(path, 900),
    );
    if (!signed) throw new HttpError("PDF indisponible", 404);
    // V1 envelopes may not have an integrity hash until first read.
    let hash = doc.current_sha256;
    if (!hash) {
      const blob = checked(
        await admin.storage.from("signatureflow-documents").download(path),
      );
      if (!blob) throw new HttpError("PDF indisponible", 404);
      hash = await sha256Bytes(new Uint8Array(await blob.arrayBuffer()));
      checked(
        await admin
          .from("signatureflow_documents")
          .update({ current_sha256: hash })
          .eq("id", doc.id)
          .is("current_sha256", null),
      );
    }
    const audit = await admin
      .from("signatureflow_audit_events")
      .insert({
        document_id: doc.id,
        signer_id: signer.id,
        event_type: "document_opened",
        metadata: {
          revision: doc.revision,
          user_agent: req.headers.get("user-agent")?.slice(0, 300),
        },
      });
    if (audit.error) throw audit.error;
    return json({
      blocked,
      signer: {
        name: signer.name,
        email: signer.email,
        role: signer.role || "",
        status: signer.status,
      },
      document: {
        name: doc.name,
        signedUrl: signed.signedUrl,
        sha256: hash,
        revision: doc.revision,
        status: doc.status,
        pageCount: doc.page_count,
        workflowType: doc.workflow_type || "approval",
        requireFullRead: doc.require_full_read !== false,
        identityStamp: doc.identity_stamp !== false,
      },
      fields,
    });
  } catch (e) {
    return failure(e);
  }
});
