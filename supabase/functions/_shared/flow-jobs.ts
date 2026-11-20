import * as lib from "npm:pdf-lib@1.17.1";
import {
  checked,
  HttpError,
  sha256Bytes,
  sha256Text,
  escapeHtml as esc,
} from "./common.ts";
import { bundle, pdfBytes, BUCKET } from "./flow-data.ts";
import { decryptLink } from "./flow-security.ts";
import { fileSlug } from "./flow-core.mjs";
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768)
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
};
async function queue(admin: any, row: any) {
  const result = await admin
    .from("sf3_jobs")
    .upsert(row, { onConflict: "job_key", ignoreDuplicates: true });
  checked(result);
}
async function ensureFinalCopies(admin: any, b: any, archive: any) {
  if (!archive.complete) return;
  const emails = new Set<string>(b.activeSigners.map((s: any) => s.email));
  b.campaigns.forEach((c: any) =>
    c.copies.forEach((email: string) => emails.add(email)),
  );
  for (const email of emails)
    await queue(admin, {
      job_key: `final:${archive.id}:${email}`,
      kind: "final_copy",
      version_id: b.version.id,
      payload: { email, archive_id: archive.id },
    });
}
async function snapshot(admin: any, versionId: string) {
  const b = await bundle(admin, versionId);
  const usable = b.envelopes.filter(
    (e: any) =>
      e.status !== "cancelled" ||
      b.signers.some(
        (s: any) => s.document_id === e.id && s.status === "signed",
      ),
  );
  const signers = b.signers.filter((s: any) =>
    usable.some((e: any) => e.id === s.document_id),
  );
  const signed = signers.filter((s: any) => s.status === "signed");
  const fingerprint = await sha256Text(
    usable
      .sort((a: any, c: any) => a.id.localeCompare(c.id))
      .map((e: any) => `${e.id}:${e.current_sha256 || ""}:${e.status}`)
      .join("|"),
  );
  return {
    ...b,
    usable,
    activeSigners: signers,
    signed,
    fingerprint,
    complete:
      b.version.state === "current" &&
      signers.length > 0 &&
      signed.length === signers.length &&
      usable.every((e: any) => e.status !== "cancelled"),
  };
}
export async function archiveVersion(admin: any, versionId: string) {
  const b = await snapshot(admin, versionId);
  if (!b.signed.length) return null;
  const existing = b.archives.find((a: any) => a.fingerprint === b.fingerprint);
  if (existing) {
    await ensureFinalCopies(admin, b, existing);
    return existing;
  }
  // Application signatures are serialized by sf3_register_campaign. The newest application PDF contains its predecessors.
  const applications = b.mappings.filter(
    (m: any) =>
      b.campaigns.find((c: any) => c.id === m.campaign_id)?.mode ===
      "application",
  );
  const appMapping = applications
    .filter((m: any) => b.usable.some((e: any) => e.id === m.envelope_id))
    .at(-1);
  const application = appMapping
    ? b.usable.find((e: any) => e.id === appMapping.envelope_id)
    : null;
  const baseBytes = await pdfBytes(
    admin,
    BUCKET,
    application?.current_storage_path || b.version.source_path,
  );
  if (
    (await sha256Bytes(baseBytes)) !==
    (application?.current_sha256 || b.version.source_sha256)
  )
    throw new Error("Empreinte du PDF différente du suivi.");
  const output = await lib.PDFDocument.create(),
    base = await lib.PDFDocument.load(baseBytes);
  (await output.copyPages(base, base.getPageIndices())).forEach((p: any) =>
    output.addPage(p),
  );
  for (const m of b.mappings) {
    if (
      b.campaigns.find((c: any) => c.id === m.campaign_id)?.mode !==
      "acknowledgement"
    )
      continue;
    const env = b.usable.find((e: any) => e.id === m.envelope_id);
    if (!env) continue;
    const envelopeBytes = await pdfBytes(
      admin,
      BUCKET,
      env.current_storage_path,
    );
    if ((await sha256Bytes(envelopeBytes)) !== env.current_sha256)
      throw new Error("Empreinte de l’annexe différente du suivi.");
    const pdf = await lib.PDFDocument.load(envelopeBytes);
    const pages = pdf.getPageIndices().slice(m.annex_start);
    (await output.copyPages(pdf, pages)).forEach((p: any) => output.addPage(p));
  }
  const font = await output.embedFont(lib.StandardFonts.Helvetica),
    page = output.addPage([595, 842]);
  const ascii = (s: string) => s.replace(/[^\x20-\xff]/g, "?");
  const lines = [
    `Tracabilite - ${b.doc.title}`,
    `Indice : ${b.version.label}`,
    `Original SHA-256 : ${b.version.source_sha256}`,
    `Signatures : ${b.signed.length} / ${b.activeSigners.length}`,
    `Etat : ${b.complete ? "collecte complete" : "collecte en cours"}`,
    "L original reste conserve sans modification. Cette copie rassemble les signatures.",
    ...b.signed.map((s: any) => `${s.name} | ${s.email} | ${s.signed_at}`),
  ];
  let current = page,
    y = 800;
  for (const line of lines) {
    if (y < 40) {
      current = output.addPage([595, 842]);
      y = 800;
    }
    current.drawText(ascii(line).slice(0, 110), { x: 35, y, size: 9, font });
    y -= 18;
  }
  const bytes = await output.save(),
    sha = await sha256Bytes(bytes),
    id = crypto.randomUUID();
  const filename = `${fileSlug(b.doc.title)}_indice-${fileSlug(b.version.label)}_${b.complete ? "complet" : "suivi"}_${b.signed.length}-${b.activeSigners.length}.pdf`;
  const bucket = b.doc.chantier_id ? "chantier-documents" : BUCKET;
  const path = b.doc.chantier_id
    ? `documents/${b.doc.chantier_id}/${id}/${filename}`
    : `flow/${b.doc.owner_id}/${b.version.id}/archives/${id}.pdf`;
  checked(
    await admin.storage
      .from(bucket)
      .upload(path, bytes, { contentType: "application/pdf", upsert: false }),
  );
  const row = {
    id,
    snapshot: b.usable.map((e: any) => ({
      id: e.id,
      sha256: e.current_sha256 || "",
      status: e.status,
    })),
    version_id: versionId,
    fingerprint: b.fingerprint,
    storage_bucket: bucket,
    storage_path: path,
    sha256: sha,
    signed_count: b.signed.length,
    expected_count: b.activeSigners.length,
    complete: b.complete,
  };
  let finalId;
  try {
    finalId = checked(
      await admin.rpc("sf3_record_archive", {
        p_archive: row,
        p_document: b.doc.chantier_id
          ? {
              ...b.doc,
              file_name: filename,
              bytes: bytes.length,
              description: `SignatureFlow - ${b.complete ? "collecte complete" : "etat intermediaire"} - original SHA-256 ${b.version.source_sha256}`,
            }
          : null,
      }),
    );
  } catch (error) {
    await admin.storage.from(bucket).remove([path]);
    throw error;
  }
  if (finalId !== id) {
    await admin.storage.from(bucket).remove([path]);
    const existing = checked(
      await admin.from("sf3_archives").select("*").eq("id", finalId).single(),
    );
    await ensureFinalCopies(admin, b, existing);
    return existing;
  }
  await ensureFinalCopies(admin, b, row);
  return row;
}
async function mailJob(admin: any, job: any) {
  const b = await bundle(admin, job.version_id);
  let payload = { ...job.payload },
    to: string,
    subject: string,
    text: string,
    attachments: any[] = [];
  let actionLink = "";
  const signer = job.signer_id
    ? b.signers.find((s: any) => s.id === job.signer_id)
    : null;
  if (["invitation", "reminder"].includes(job.kind)) {
    if (
      b.version.state !== "current" ||
      !signer ||
      signer.status === "signed" ||
      signer.status === "cancelled" ||
      new Date(signer.token_expires_at || 0) < new Date()
    )
      return;
    const recipient = checked(
      await admin
        .from("sf3_recipients")
        .select("link_cipher")
        .eq("signer_id", signer.id)
        .single(),
    );
    if (recipient.link_cipher !== payload.cipher) return;
    const link = await decryptLink(payload.cipher);
    actionLink = link;
    to = signer.email;
    subject = `${job.kind === "reminder" ? "Rappel - " : ""}Document a consulter - ${b.doc.title} - indice ${b.version.label}`;
    text = `Bonjour ${signer.name},\n${b.doc.title} - indice ${b.version.label}\nFonction : ${signer.role}\nConsultez le document et signez avec ce lien personnel (aucun compte Journal de chantier requis) :\n${link}\nLien valable jusqu au ${signer.token_expires_at}.`;
  } else if (job.kind === "receipt") {
    if (!signer || signer.status !== "signed") return;
    to = signer.email;
    subject = `Votre signature est enregistree - ${b.doc.title} - indice ${b.version.label}`;
    if (!payload.pdf_path) {
      const envelope = b.envelopes.find(
        (e: any) => e.id === signer.document_id,
      );
      payload.pdf_path = envelope.current_storage_path;
      payload.pdf_bucket = BUCKET;
      checked(
        await admin
          .from("sf3_jobs")
          .update({ payload })
          .eq("id", job.id)
          .eq("lease_id", job.lease_id),
      );
    }
    const pdf = await pdfBytes(admin, payload.pdf_bucket, payload.pdf_path);
    attachments = [
      {
        filename: `${fileSlug(b.doc.title)}_votre-signature.pdf`,
        content: b64(pdf),
      },
    ];
    text = `Bonjour ${signer.name},\nVotre signature sur ${b.doc.title}, indice ${b.version.label}, a ete enregistree le ${signer.signed_at}.\nVotre copie est jointe. L original reste conserve dans le dossier documentaire.`;
  } else {
    const archive = checked(
      await admin
        .from("sf3_archives")
        .select("*")
        .eq("id", payload.archive_id)
        .single(),
    );
    to = payload.email;
    const bytes = await pdfBytes(
      admin,
      archive.storage_bucket,
      archive.storage_path,
    );
    attachments = [
      {
        filename: `${fileSlug(b.doc.title)}_indice-${fileSlug(b.version.label)}_complet.pdf`,
        content: b64(bytes),
      },
    ];
    subject = `Dossier complete - ${b.doc.title} - indice ${b.version.label}`;
    text = `Toutes les signatures attendues pour cette collecte ont ete enregistrees.\nDocument : ${b.doc.title}\nIndice : ${b.version.label}\nOriginal SHA-256 : ${b.version.source_sha256}\nLe dossier est joint.`;
  }
  const key = Deno.env.get("RESEND_API_KEY"),
    from =
      Deno.env.get("SIGNATUREFLOW_EMAIL_FROM") ||
      Deno.env.get("JOURNAL_CR_FROM") ||
      Deno.env.get("EMAIL_FROM");
  if (!key || !from)
    throw new HttpError(
      "RESEND_API_KEY et SIGNATUREFLOW_EMAIL_FROM requis",
      503,
    );
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `sf3-${job.id}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html: `<div style="font-family:Arial;line-height:1.7;white-space:pre-wrap">${actionLink ? esc(text).replace(esc(actionLink), `<a href="${esc(actionLink)}">Consulter le document et signer</a>`) : esc(text)}</div>`,
      ...(attachments.length ? { attachments } : {}),
    }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message || `E-mail refuse (${response.status})`);
  checked(
    await admin
      .from("sf3_jobs")
      .update({ resend_id: result.id })
      .eq("id", job.id)
      .eq("lease_id", job.lease_id),
  );
  if (signer && ["invitation", "reminder"].includes(job.kind))
    checked(
      await admin
        .from("sf3_recipients")
        .update({
          email_status: "accepted",
          ...(job.kind === "reminder"
            ? { last_reminded_at: new Date().toISOString() }
            : {}),
        })
        .eq("signer_id", signer.id),
    );
  checked(await admin.rpc("sf3_apply_delivery", { p_email_id: result.id }));
}
export async function scheduleReminders(admin: any, versionId?: string) {
  return checked(
    await admin.rpc("sf3_schedule_reminders", { p_version: versionId || null }),
  );
}
export async function runJobs(admin: any, versionId?: string, limit = 5) {
  const results = [];
  const started = Date.now();
  for (let i = 0; i < limit && Date.now() - started < 45000; i++) {
    const lease = crypto.randomUUID(),
      jobs =
        checked(
          await admin.rpc("sf3_claim_jobs", {
            p_lease: lease,
            p_limit: 1,
            p_version: versionId || null,
          }),
        ) || [];
    if (!jobs.length) break;
    const job = jobs[0];
    try {
      if (job.kind === "archive") await archiveVersion(admin, job.version_id);
      else await mailJob(admin, job);
      checked(
        await admin
          .from("sf3_jobs")
          .update({
            status: "done",
            lease_id: null,
            lease_until: null,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lease_id", lease),
      );
      results.push({ id: job.id, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Erreur de traitement";
      const delay = Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
      checked(
        await admin
          .from("sf3_jobs")
          .update({
            status: "error",
            last_error: error.slice(0, 500),
            available_at: new Date(Date.now() + delay * 1000).toISOString(),
            lease_id: null,
            lease_until: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lease_id", lease),
      );
      results.push({ id: job.id, ok: false, error });
    }
  }
  return results;
}
