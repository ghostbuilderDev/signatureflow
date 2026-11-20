import { context, sitePermission } from "./flow-data.ts";
import { HttpError, sha256Text } from "./common.ts";
const encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function key() {
  const raw = Deno.env.get("SIGNATUREFLOW_FLOW_KEY") || "";
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw new HttpError(
      "Le secret SIGNATUREFLOW_FLOW_KEY doit contenir 64 caractères hexadécimaux.",
      503,
    );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw.match(/../g)!, (b) => parseInt(b, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptLink(link: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    new TextEncoder().encode(link),
  );
  return encode(iv) + "." + encode(new Uint8Array(c));
}
export async function decryptLink(cipher: string) {
  const [a, b] = cipher.split(".");
  if (!a || !b) throw new Error("Lien indisponible");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(a) },
      await key(),
      decode(b),
    ),
  );
}
export function publicBase() {
  const u = new URL(Deno.env.get("SIGNATUREFLOW_APP_URL") || "");
  if (u.protocol !== "https:")
    throw new HttpError("SIGNATUREFLOW_APP_URL HTTPS requis", 503);
  u.search = "";
  u.hash = "";
  return u;
}
export async function verifySvix(
  raw: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
) {
  const id = headers.get("svix-id") || "",
    timestamp = headers.get("svix-timestamp") || "",
    signature = headers.get("svix-signature") || "";
  if (
    !id ||
    !/^[0-9]+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !secret.startsWith("whsec_")
  )
    throw new HttpError("Webhook invalide", 401);
  const k = await crypto.subtle.importKey(
    "raw",
    decode(secret.slice(6)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  let valid = false;
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version === "v1" && value) {
      try {
        valid ||= await crypto.subtle.verify("HMAC", k, decode(value), message);
      } catch {}
    }
  }
  if (!valid) throw new HttpError("Signature du webhook invalide", 401);
  return id;
}
export async function verifyJobSecret(req: Request) {
  const configured = Deno.env.get("SIGNATUREFLOW_JOB_TOKEN") || "";
  const token = (req.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (
    configured.length < 32 ||
    !token ||
    (await sha256Text(token)) !== (await sha256Text(configured))
  )
    throw new HttpError("Accès au traitement refusé", 401);
}

export async function authorizeFlowEnvelope(req: Request, doc: any) {
  if (!doc.sf3_managed) return;
  if (!/^[a-f0-9]{64}$/i.test(Deno.env.get("SIGNATUREFLOW_FLOW_KEY") || ""))
    throw new HttpError(
      "Configurez SIGNATUREFLOW_FLOW_KEY avant la diffusion.",
      503,
    );
  const ctx = await context(req);
  if (doc.sf3_chantier_id) await sitePermission(ctx, doc.sf3_chantier_id, true);
}
