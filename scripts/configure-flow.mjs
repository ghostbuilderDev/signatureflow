#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
const args = process.argv.slice(2),
  arg = (n, d) => {
    const i = args.indexOf(n);
    return i < 0 ? d : args[i + 1];
  };
const project = arg("--project", "eqfwdcttvnnrakyaacjm"),
  from = arg("--from", "SignatureFlow <documents@journaldechantier.fr>"),
  app = arg("--app-url", "https://ghostbuilderdev.github.io/signatureflow/");
if (
  !/^[a-z0-9]{20}$/.test(project) ||
  new URL(app).protocol !== "https:" ||
  !/^.+<[^\s<>]+@journaldechantier\.fr>$/.test(from)
)
  throw new Error(
    "Projet, URL HTTPS ou expéditeur journaldechantier.fr invalide.",
  );
async function secret(prompt) {
  if (!process.stdin.isTTY)
    throw new Error(
      "Lance cette configuration dans le terminal interactif Termux.",
    );
  process.stdout.write(prompt + " ");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    function keypress(s, k) {
      if (k?.ctrl && k.name === "c") {
        done();
        reject(new Error("Configuration interrompue."));
      } else if (k?.name === "return") {
        done();
        resolve(value);
      } else if (k?.name === "backspace") value = value.slice(0, -1);
      else if (s && !k?.ctrl) value += s;
    }
    process.stdin.on("keypress", keypress);
  });
}
const managementToken =
  process.env.SUPABASE_ACCESS_TOKEN?.trim() ||
  (await secret("Jeton personnel Supabase (saisie masquée) :")).trim();
if (!managementToken) throw new Error("Jeton Supabase manquant.");
async function management(path, payload) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${project}/${path}`,
    {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${managementToken}`,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(`Supabase ${path} : HTTP ${response.status}. Vérifie le projet et les droits du jeton.`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}
const directory = join(homedir(), ".config", "signatureflow");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const local = join(directory, project + "-flow-secrets.json");
let saved = existsSync(local) ? JSON.parse(readFileSync(local, "utf8")) : {};
const names = new Set((await management("secrets")).map((entry) => entry.name));
const updates = { SIGNATUREFLOW_APP_URL: app, SIGNATUREFLOW_EMAIL_FROM: from };
for (const name of ["SIGNATUREFLOW_FLOW_KEY", "SIGNATUREFLOW_JOB_TOKEN"]) {
  if (!names.has(name)) {
    saved[name] ||= randomBytes(32).toString("hex");
    updates[name] = saved[name];
  }
}
writeFileSync(local, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
chmodSync(local, 0o600);
if (!names.has("RESEND_API_KEY")) {
  const key = await secret("Clé API Resend (saisie masquée) :");
  if (!key.startsWith("re_") || /[\r\n]/.test(key))
    throw new Error("Clé Resend invalide.");
  updates.RESEND_API_KEY = key;
}
if (!names.has("RESEND_WEBHOOK_SECRET")) {
  const key = await secret(
    "Secret du webhook Resend whsec_… (saisie masquée) :",
  );
  if (!key.startsWith("whsec_") || /[\r\n]/.test(key))
    throw new Error(
      "Crée le webhook Resend indiqué dans le guide, puis relance.",
    );
  updates.RESEND_WEBHOOK_SECRET = key;
}
let jobToken = saved.SIGNATUREFLOW_JOB_TOKEN;
if (!jobToken) {
  jobToken = await secret(
    "Secret SIGNATUREFLOW_JOB_TOKEN déjà configuré (conservé, sans rotation) :",
  );
  if (jobToken.length < 32 || /[\r\n]/.test(jobToken))
    throw new Error(
      "Secret de traitement requis pour configurer la planification.",
    );
  saved.SIGNATUREFLOW_JOB_TOKEN = jobToken;
  writeFileSync(local, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
}
if (!/^[a-f0-9]{64}$/i.test(jobToken))
  throw new Error("La clé du traitement automatique doit contenir 64 caractères hexadécimaux.");
await management("secrets", Object.entries(updates).map(([name, value]) => ({name, value})));

const quote = (s) => "'" + s.replace(/'/g, "''") + "'";
const command = `select net.http_post(
  url := 'https://${project}.supabase.co/functions/v1/signatureflow-flow-worker',
  headers := jsonb_build_object('Content-Type','application/json','Authorization',
    'Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='sf3_job_token')),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000
);`;
await management("database/query", { query: `
  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;
  do $body$
  declare ident uuid;
  begin
    select id into ident from vault.secrets where name='sf3_job_token';
    if ident is null then
      perform vault.create_secret(${quote(jobToken)},'sf3_job_token');
    else
      perform vault.update_secret(ident,${quote(jobToken)},'sf3_job_token');
    end if;
  end;
  $body$;
  select cron.schedule('signatureflow-flow-worker','* * * * *',${quote(command)});
` });
console.log("Secrets configurés. Le traitement automatique est planifié chaque minute.");
console.log("Clés du module sauvegardées dans " + local + " (accès privé).");
console.log("Conserve la clé SIGNATUREFLOW_FLOW_KEY pour garder les liens existants accessibles.");
