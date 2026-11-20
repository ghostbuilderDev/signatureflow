import { createClient } from "@supabase/supabase-js";
import "../integration/document-flow-ui.js";
import "../integration/document-flow.css";
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const client =
  url && key
    ? createClient(url, key, {
        auth: {
          storageKey: "signatureflow-auth",
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;
const host = document.querySelector("#flow-app");
let user = null,
  ui;
async function start() {
  const session = client ? (await client.auth.getSession()).data.session : null;
  user = session?.user;
  if (!user) {
    host.textContent =
      "Connectez-vous à votre espace organisateur pour gérer les documents. Les destinataires peuvent signer directement depuis leur lien personnel, sans compte.";
    const a = document.createElement("a");
    a.href = "./";
    a.textContent = "Ouvrir la connexion SignatureFlow";
    a.style.display = "block";
    host.append(a);
    return;
  }
  ui = window.SignatureFlowDocumentUI.create({
    supabaseUrl: url,
    publicKey: key,
    getClient: () => client,
    getState: () => ({ user }),
    onClose: () => {
      location.href = "./";
    },
  });
  await ui.mount(host);
}
client?.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    user = null;
    ui?.destroy();
    location.href = "./";
  }
});
start().catch((e) => {
  host.textContent = e.message;
});
