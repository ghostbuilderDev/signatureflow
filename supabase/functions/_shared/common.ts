import { createClient } from "npm:@supabase/supabase-js@2.57.4";
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
export class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export function adminClient() {
  const key =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY");
  if (!key) throw new HttpError("Configuration serveur incomplète", 503);
  return createClient(Deno.env.get("SUPABASE_URL")!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export function checked<T extends { error: unknown; data: unknown }>(
  result: T,
): T["data"] {
  if (result.error) throw new HttpError((result.error as Error).message, 409);
  return result.data;
}
export async function body(req: Request, max = 1_500_000) {
  if (req.method !== "POST") throw new HttpError("Méthode non autorisée", 405);
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError("Requête vide");
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new HttpError("Requête trop volumineuse", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError("JSON invalide");
  }
}
export async function requireUser(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!jwt) throw new HttpError("Connexion requise", 401);
  const { data, error } = await adminClient().auth.getUser(jwt);
  if (error || !data.user) throw new HttpError("Session expirée", 401);
  return data.user;
}
export const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function sha256Bytes(value: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", value as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export const sha256Text = (value: string) =>
  sha256Bytes(new TextEncoder().encode(value));
export function validToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !/^([a-f0-9]{64})$/.test(token))
    throw new HttpError("Lien invalide", 404);
}
export const escapeHtml = (v = "") =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function failure(e: unknown) {
  const error = e as Error;
  return json(
    { error: error.message || "Erreur serveur" },
    e instanceof HttpError ? e.status : 500,
  );
}
