/** Optional JDC bridge. Pass JDC's authenticated Supabase client. Never pass service_role. */
const unwrap = (r) => {
  if (r.error) throw r.error;
  return r.data;
};
export async function prepareSignatureFlow({
  supabase,
  file,
  title,
  sourceRef = "",
  signers = [],
  appUrl,
}) {
  if (!(file instanceof Blob) || file.size > 20 * 1024 * 1024)
    throw new Error("PDF absent ou supérieur à 20 Mo");
  if (!(await file.slice(0, 1024).text()).includes("%PDF-"))
    throw new Error("Document PDF invalide");
  if (signers.length > 40) throw new Error("40 signataires maximum");
  const session = unwrap(await supabase.auth.getSession()).session;
  if (!session) throw new Error("Connexion au Journal requise");
  const url = new URL(appUrl);
  if (url.protocol !== "https:")
    throw new Error("URL SignatureFlow HTTPS requise");
  const id = crypto.randomUUID(),
    path = `${session.user.id}/${id}/original.pdf`,
    seen = new Set();
  const recipients = signers.map((s, i) => {
    const email = s.email.trim().toLowerCase();
    if (seen.has(email) || !/^\S+@\S+\.\S+$/.test(email) || !s.name?.trim())
      throw new Error("Signataire invalide ou en double");
    seen.add(email);
    return {
      id: crypto.randomUUID(),
      document_id: id,
      name: s.name.trim(),
      email,
      role: s.role || "",
      signing_order: i + 1,
    };
  });
  unwrap(
    await supabase
      .from("signatureflow_documents")
      .insert({
        id,
        owner_id: session.user.id,
        name: (title || file.name || "Document à signer").slice(0, 200),
        source_ref: String(sourceRef).slice(0, 200),
        storage_path: path,
        current_storage_path: path,
      }),
  );
  try {
    unwrap(
      await supabase.storage
        .from("signatureflow-documents")
        .upload(path, file, { contentType: "application/pdf" }),
    );
    if (recipients.length)
      unwrap(await supabase.from("signatureflow_signers").insert(recipients));
  } catch (e) {
    await supabase.storage.from("signatureflow-documents").remove([path]);
    await supabase.from("signatureflow_documents").delete().eq("id", id);
    throw e;
  }
  url.searchParams.set("document", id);
  return { documentId: id, editorUrl: url.href };
}
export async function getSignatureFlowProgress(supabase, documentId) {
  const document = unwrap(
    await supabase
      .from("signatureflow_documents")
      .select("id,name,status,source_ref,updated_at,current_sha256")
      .eq("id", documentId)
      .single(),
  );
  const signers = unwrap(
    await supabase
      .from("signatureflow_signers")
      .select("id,name,email,status,signed_at,signing_order")
      .eq("document_id", documentId)
      .order("signing_order"),
  );
  return {
    document,
    signers,
    signed: signers.filter((s) => s.status === "signed").length,
    total: signers.length,
  };
}
