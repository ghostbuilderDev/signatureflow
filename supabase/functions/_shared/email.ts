import { escapeHtml as esc } from "./common.ts";

function base64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function emailConfiguration() {
  return {
    apiKey: Deno.env.get("RESEND_API_KEY") || "",
    from:
      Deno.env.get("SIGNATUREFLOW_EMAIL_FROM") ||
      Deno.env.get("JOURNAL_CR_FROM") ||
      Deno.env.get("EMAIL_FROM") ||
      "",
  };
}

export async function sendSignedPdf({
  to,
  recipientName,
  documentName,
  pdf,
  filename,
  final,
}: {
  to: string;
  recipientName?: string;
  documentName: string;
  pdf: Uint8Array;
  filename: string;
  final: boolean;
}) {
  const { apiKey, from } = emailConfiguration();
  if (!apiKey || !from)
    throw new Error(
      "Envoi automatique non configuré (RESEND_API_KEY / SIGNATUREFLOW_EMAIL_FROM)",
    );
  const title = final ? "Document entièrement signé" : "Votre prise de connaissance",
    intro = final
      ? "Toutes les signatures attendues ont été recueillies."
      : "Votre signature de prise de connaissance a été enregistrée.";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `${title} — ${documentName}`,
      text: `Bonjour${recipientName ? ` ${recipientName}` : ""},\n${intro}\nLe PDF « ${documentName} » est joint à ce message.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2>${esc(title)}</h2><p>Bonjour${recipientName ? ` ${esc(recipientName)}` : ""},</p><p>${esc(intro)}</p><p>Le PDF « <strong>${esc(documentName)}</strong> » est joint à ce message.</p></div>`,
      attachments: [{ filename, content: base64(pdf) }],
    }),
  });
  let payload: { id?: string; message?: string } = {};
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok)
    throw new Error(payload.message || `E-mail refusé (${response.status})`);
  return payload.id || "sent";
}
