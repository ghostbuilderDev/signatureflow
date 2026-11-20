// Add only SignatureFlow's callback URLs; preserve JDC's site URL and settings.
const {
  SUPABASE_ACCESS_TOKEN: token,
  SUPABASE_PROJECT_REF: ref,
  SIGNATUREFLOW_PUBLIC_URL: raw,
} = process.env;
if (!token || !/^[a-z0-9]+$/.test(ref || "") || !raw)
  throw new Error("Configuration de connexion incomplète.");
const app = new URL(raw);
if (app.protocol !== "https:")
  throw new Error("L’application publiée doit utiliser HTTPS.");
app.hash = "";
app.search = "";
const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
async function request(method, body) {
  const response = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Configuration Auth refusée (HTTP ${response.status}). Vérifiez les droits du token Supabase : auth_config_read et auth_config_write.`,
    );
  return response.json();
}
const config = await request("GET");
const entries = new Set(
  (config.uri_allow_list || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
entries.add(app.href);
entries.add(new URL("?recovery=1", app).href);
await request("PATCH", { uri_allow_list: [...entries].join(",") });
console.log(
  "Retour des e-mails de connexion et de récupération configuré pour SignatureFlow.",
);
