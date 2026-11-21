import signatureflowPackage from "../package.json";
import "./style.css";
import "../integration/document-flow-ui.js";
import { createClient } from "@supabase/supabase-js";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import SignaturePad from "signature_pad";
import { analyzePdf } from "./lib/analyzer.js";
import { bounded, overlap } from "./lib/detection-core.js";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
const pdfOptions = {
  standardFontDataUrl: new URL(
    `${import.meta.env.BASE_URL}pdf-fonts/`,
    location.href,
  ).href,
};
const APP_URL = import.meta.env.VITE_APP_URL || location.href.split(/[?#]/)[0];
const supabase =
  import.meta.env.VITE_SUPABASE_URL &&
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    ? createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            storageKey: "signatureflow-auth",
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        },
      )
    : null;
const app = document.querySelector("#app"),
  $ = (s) => document.querySelector(s);
const esc = (s = "") =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uuid = () => crypto.randomUUID(),
  statusNames = {
    draft: "Brouillon",
    in_progress: "En signature",
    signed: "Signé",
    cancelled: "Annulé",
    pending: "En attente",
    signing: "Enregistrement",
  };
const kinds = {
  signature: "Signature",
  initials: "Paraphe",
  name: "Nom et prénom",
  date: "Date de signature",
  text: "Texte à compléter",
  checkbox: "Case à cocher",
};
const S = {
  session: null,
  docs: [],
  doc: null,
  signers: [],
  contacts: [],
  fields: [],
  audit: [],
  pdf: null,
  bytes: null,
  page: 1,
  selected: null,
  dirty: false,
  demo: false,
  links: [],
  analysis: null,
  renderId: 0,
};
let resizeObserver,
  renderTask,
  analysisController,
  pads = [];
const editable = () => S.doc?.status === "draft";
const check = (r) => {
  if (r.error) throw r.error;
  return r.data;
};
const date = (v) => (v ? new Date(v).toLocaleString("fr-FR") : "—");
function notify(text, type = "notice") {
  let n = $("#notice");
  if (!n) {
    n = document.createElement("div");
    n.id = "notice";
    n.setAttribute("role", "status");
    document.body.append(n);
  }
  n.className = type;
  n.textContent = text;
}
function shell(content, right = "") {
  resizeObserver?.disconnect();
  pads.forEach((p) => {
    p.off();
    p._observer?.disconnect();
  });
  pads = [];
  app.innerHTML = `<header class="topbar"><a class="brand" href="${esc(location.pathname)}" aria-label="SignatureFlow accueil"><span class="brand-mark">S<span>f</span></span>Signature<span class="brand-light">Flow</span></a><div class="row">${S.demo ? '<span class="pill">Essai local</span>' : ""}${right}<span class="version">v${esc(signatureflowPackage.version)}</span></div></header>${content}`;
}
async function busy(button, fn) {
  if (button?.disabled) return;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Veuillez patienter…";
  }
  try {
    return await fn();
  } catch (e) {
    if (["shareLinks", "emailLinks", "save"].includes(button?.id))
      showPreparationError(e);
    notify(e.message || "Une erreur est survenue.", "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}
async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try {
      message = (await error.context.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
const fileName = () => S.doc.name.replace(/[^\p{L}\p{N}._-]/gu, "_");
function dirty() {
  S.dirty = true;
  if (S.doc?.status === "draft") S.doc.prepared_at = null;
  if ($("#confirmPreparation")) $("#confirmPreparation").checked = false;
  if ($("#preparationFeedback")) $("#preparationFeedback").hidden = true;
  $("#savedState")?.replaceChildren(
    document.createTextNode("Modifications à enregistrer"),
  );
}
window.addEventListener("beforeunload", (e) => {
  if (S.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("unhandledrejection", (e) =>
  notify(e.reason?.message || "Opération interrompue", "error"),
);
async function boot() {
  const authParams = new URLSearchParams(location.hash.slice(1));
  S.recovering = authParams.get("type") === "recovery";
  const authError =
    authParams.get("error_description") ||
    new URLSearchParams(location.search).get("error_description");
  const token =
    new URLSearchParams(location.hash.slice(1)).get("sign") ||
    new URLSearchParams(location.search).get("sign");
  if (token) {
    sessionStorage.setItem("signatureflow_sign_token", token);
    history.replaceState({}, "", location.pathname);
  }
  const requestedDocument = new URLSearchParams(location.search).get(
    "document",
  );
  if (requestedDocument && /^[a-f0-9-]{36}$/.test(requestedDocument))
    sessionStorage.setItem("signatureflow_open_document", requestedDocument);
  const stored = token || sessionStorage.getItem("signatureflow_sign_token");
  if (stored) return signingPage(stored);
  if (!supabase) return login();
  S.session = check(await supabase.auth.getSession()).session;
  supabase.auth.onAuthStateChange((_e, session) => {
    const previous = S.session?.user.id;
    S.session = session;
    if (S.authSubmitting) return;
    if (_e === "PASSWORD_RECOVERY") {
      S.recovering = true;
      setTimeout(() => passwordRecovery(), 0);
      return;
    }
    if (S.recovering) return;
    if (session?.user.id && session.user.id !== previous && !S.demo)
      setTimeout(() => dashboard().catch((e) => notify(e.message, "error")), 0);
    if (!session && previous && !S.demo) login();
  });
  if (S.recovering && S.session) passwordRecovery();
  else if (S.session) await dashboard();
  else login();
  if (authError)
    notify(
      "Ce lien de connexion est invalide ou expiré. Connectez-vous avec votre mot de passe ou demandez un nouveau lien.",
      "error",
    );
}
function login() {
  shell(
    `<main class="welcome"><section class="intro"><div class="eyebrow">VOS DOCUMENTS. LEURS SIGNATURES.</div><h1>Du document<br>à la signature,<br><em>en quelques gestes.</em></h1><p>Préparez vos PDF, indiquez qui signe et partagez un lien personnel. Chacun peut lire et signer depuis son téléphone.</p><div class="steps"><span>01 · Importer</span><span>02 · Préparer</span><span>03 · Faire signer</span></div></section><section class="card auth"><span class="eyebrow">ESPACE ORGANISATEUR</span><h2>Ouvrir mon espace</h2><p class="muted">Connectez-vous à votre espace organisateur SignatureFlow. Votre compte Journal de chantier fonctionne également ici. Les destinataires signent depuis leur lien personnel, sans compte.</p><form id="loginForm" class="stack"><label>E-mail<input required id="email" type="email" autocomplete="username" placeholder="vous@entreprise.fr"></label><label>Mot de passe<input required id="password" type="password" autocomplete="current-password"></label><label class="small"><input id="showPassword" type="checkbox"> Afficher le mot de passe</label><button class="btn primary" ${supabase ? "" : "disabled"}>Se connecter →</button></form><div class="stack" style="margin-top:16px"><button class="btn secondary" id="resetPassword" ${supabase ? "" : "disabled"}>Mot de passe oublié / définir mon mot de passe</button><button class="btn secondary" id="magicLink" ${supabase ? "" : "disabled"}>Recevoir plutôt un lien par e-mail</button></div>${supabase ? "" : '<p class="warning">La connexion n’est pas configurée. Contactez l’organisateur.</p>'}<hr><button class="btn secondary" id="demo">Essayer l’analyse sur mon PDF</button><p class="small muted">L’essai analyse le PDF sur cet appareil. Pour partager un lien, connectez-vous à votre espace.</p></section></main>`,
  );
  $("#loginForm").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      S.authSubmitting = true;
      let result;
      try {
        result = await supabase.auth.signInWithPassword({
          email: $("#email").value.trim(),
          password: $("#password").value,
        });
      } finally {
        S.authSubmitting = false;
      }
      const { data, error } = result;
      if (error) throw new Error(authMessage(error));
      S.session = data.session;
      $("#password").value = "";
      await dashboard();
    });
  };
  $("#showPassword").onchange = (e) => {
    $("#password").type = e.target.checked ? "text" : "password";
  };
  const sendEmail = (button, reset) =>
    busy(button, async () => {
      const email = $("#email");
      if (!email.reportValidity()) return;
      const result = reset
        ? await supabase.auth.resetPasswordForEmail(email.value.trim(), {
            redirectTo: new URL("?recovery=1", APP_URL).href,
          })
        : await supabase.auth.signInWithOtp({
            email: email.value.trim(),
            options: { emailRedirectTo: APP_URL, shouldCreateUser: false },
          });
      if (result.error) throw new Error(authMessage(result.error));
      notify(
        "Si ce compte existe, un e-mail vous a été envoyé. Consultez aussi les indésirables. Ouvrez le lien le plus récent dans votre navigateur.",
        "success",
      );
    });
  $("#resetPassword").onclick = (e) => sendEmail(e.currentTarget, true);
  $("#magicLink").onclick = (e) => sendEmail(e.currentTarget, false);
  $("#demo").onclick = () => {
    S.demo = true;
    S.docs = [];
    dashboard();
  };
}
function authMessage(error) {
  if (/invalid.*credentials/i.test(error.message))
    return "E-mail ou mot de passe incorrect. Utilisez votre compte organisateur, ou définissez votre mot de passe avec le bouton ci-dessous.";
  if (/confirm/i.test(error.message))
    return "Confirmez votre adresse e-mail avant de vous connecter.";
  if (/rate|too many|after.*second/i.test(error.message))
    return "Trop de demandes rapprochées. Patientez avant de réessayer.";
  if (/fetch|network/i.test(error.message))
    return "Connexion au serveur impossible. Vérifiez votre connexion internet.";
  return error.message || "Connexion impossible.";
}
function passwordRecovery() {
  shell(
    `<main class="container"><section class="card auth stack"><h1>Définir mon mot de passe</h1><p>Si vous utilisez également Journal de chantier avec ce compte, le mot de passe sera commun.</p><form id="recoveryForm" class="stack"><label>Nouveau mot de passe<input id="newPassword" type="password" autocomplete="new-password" minlength="12" required></label><label>Confirmer le mot de passe<input id="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label><p class="small muted">Au moins 12 caractères.</p><button class="btn primary">Enregistrer mon mot de passe</button></form><button id="cancelRecovery" class="btn secondary">Annuler et se déconnecter</button></section></main>`,
  );
  $("#recoveryForm").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      if ($("#newPassword").value !== $("#confirmPassword").value)
        throw new Error("Les deux mots de passe ne correspondent pas.");
      const { error } = await supabase.auth.updateUser({
        password: $("#newPassword").value,
      });
      if (error) throw new Error(authMessage(error));
      S.recovering = false;
      history.replaceState({}, "", location.pathname);
      S.session = check(await supabase.auth.getSession()).session;
      await dashboard();
      notify("Mot de passe enregistré.", "success");
    });
  };
  $("#cancelRecovery").onclick = () =>
    busy($("#cancelRecovery"), async () => {
      S.recovering = false;
      await supabase.auth.signOut();
      history.replaceState({}, "", location.pathname);
      login();
    });
}
async function dashboard() {
  S.doc = null;
  S.dirty = false;
  S.links = [];
  await S.pdf?.destroy();
  S.pdf = null;
  if (!S.demo && S.session) {
    const pending = sessionStorage.getItem("signatureflow_open_document");
    if (pending) {
      sessionStorage.removeItem("signatureflow_open_document");
      try {
        return await openDocument(pending);
      } catch (e) {
        notify("Le dossier demandé est inaccessible : " + e.message, "error");
      }
    }
  }
  if (!S.demo) {
    const [documents, contacts] = await Promise.all([
      supabase
        .from("signatureflow_documents")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.from("signatureflow_contacts").select("*").order("name"),
    ]);
    S.docs = check(documents);
    S.contacts = check(contacts);
  }
  const count = (s) => S.docs.filter((d) => d.status === s).length;
  shell(
    `<main class="container"><div class="page-heading"><div><span class="eyebrow">ESPACE DOCUMENTS</span><h1>Les signatures avancent.</h1><p class="muted">Préparez un document et suivez chaque réponse au même endroit.</p></div>${!S.demo ? '<a class="btn secondary" href="./document-flow.html">Documents, versions et diffusions</a>' : ""}<button class="btn secondary" id="logout">${S.demo ? "Quitter l’essai" : "Déconnexion"}</button></div><div class="metrics"><div><strong>${count("draft")}</strong><span>À préparer</span></div><div><strong>${count("in_progress")}</strong><span>En signature</span></div><div><strong>${count("signed")}</strong><span>Finalisés</span></div></div><div class="dashboard-grid"><section class="card stack"><span class="eyebrow">NOUVEAU DOCUMENT</span><h2>Commencez par votre PDF</h2><form id="uploadForm" class="stack">${window.SignatureFlowDocumentUI.pdfDropzoneMarkup("file", "20 Mo maximum · 200 pages")}<label>Nom du document<input id="docName" required maxlength="200" placeholder="Ex. Briefing · Montereau · S49"></label><label>Référence du chantier (facultatif)<input id="sourceRef" maxlength="200" placeholder="Nom ou identifiant Journal de Chantier"></label><label>Type de circuit<select id="workflowType"><option value="approval">Validation — toutes les signatures sont nécessaires</option><option value="acknowledgement">Prise de connaissance — accusé individuel</option></select></label><label>Envoi du PDF signé<select id="completionMode"><option value="all_after_complete">Après la dernière signature, à tous les participants</option><option value="signer_after_each">Après chaque prise de connaissance, à la personne</option><option value="manual">Aucun envoi automatique</option></select></label><label>Autres personnes en copie à la fin (facultatif)<textarea id="completionRecipients" rows="2" maxlength="4000" placeholder="Une ou plusieurs adresses séparées par une virgule"></textarea></label><label class="check"><input id="requireFullRead" type="checkbox" checked>Chaque signataire doit consulter toutes les pages</label><label class="check"><input id="identityStamp" type="checkbox" checked>Inscrire le nom et la fonction avec la signature dans le PDF</label><button class="btn primary">Importer et préparer →</button></form></section><section class="card"><div class="row between"><h2>Mes documents</h2><label class="sr-only" for="filter">Rechercher</label><input id="filter" class="search" placeholder="Rechercher un document…"></div><div id="documentList"></div></section></div></main>`,
  );
  const list = () => {
    $("#documentList").innerHTML =
      S.docs
        .filter((d) =>
          d.name.toLowerCase().includes($("#filter").value.toLowerCase()),
        )
        .map(
          (d) =>
            `<button class="document-row" data-doc="${d.id}"><span class="pdf-icon">PDF</span><span class="document-title"><strong>${esc(d.name)}</strong><small>${esc(d.source_ref || "Document PDF")} · ${date(d.created_at)}</small></span><span class="pill ${d.status}">${statusNames[d.status]}</span><span>↗</span></button>`,
        )
        .join("") ||
      '<div class="empty"><span>↗</span><h3>Tout commence par un document.</h3><p>Importez votre PDF pour préparer la première signature.</p></div>';
    document
      .querySelectorAll("[data-doc]")
      .forEach(
        (el) =>
          (el.onclick = () => busy(el, () => openDocument(el.dataset.doc))),
      );
  };
  list();
  $("#filter").oninput = list;
  $("#logout").onclick = () => {
    S.demo = false;
    if (S.session) supabase.auth.signOut();
    else login();
  };
  let inferredName = "";
  const picker = window.SignatureFlowDocumentUI.bindPdfDropzone(
    document.querySelector("[data-pdf-dropzone]"),
    (file) => {
      const name = $("#docName");
      if (!name.value || name.value === inferredName)
        name.value = file.name.replace(/\.pdf$/i, "");
      inferredName = file.name.replace(/\.pdf$/i, "");
    },
  );
  $("#workflowType").onchange = (e) => {
    $("#completionMode").value =
      e.target.value === "acknowledgement"
        ? "signer_after_each"
        : "all_after_complete";
  };
  $("#uploadForm").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await picker.ready();
      return createDocument(picker.getFile());
    });
  };
}
async function createDocument(file) {
  const name = $("#docName").value.trim(),
    source_ref = $("#sourceRef").value.trim(),
    workflow_type = $("#workflowType").value,
    completion_mode = $("#completionMode").value,
    completion_recipients = $("#completionRecipients")
      .value.split(/[;,\n]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    require_full_read = $("#requireFullRead").checked,
    identity_stamp = $("#identityStamp").checked;
  if (!file || !name) throw new Error("Choisissez un PDF et un nom.");
  if (
    completion_recipients.some(
      (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    )
  )
    throw new Error("Une adresse de copie finale est invalide.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Le PDF dépasse 20 Mo.");
  const bytes = await file.arrayBuffer();
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-"))
    throw new Error("Fichier PDF invalide.");
  const pdf = await pdfjs.getDocument({ ...pdfOptions, data: bytes.slice(0) })
    .promise;
  if (pdf.numPages > 200) {
    await pdf.destroy();
    throw new Error("Le document dépasse 200 pages.");
  }
  const id = uuid(),
    storage_path = `${S.session?.user.id}/${id}/original.pdf`;
  const doc = {
    id,
    name,
    source_ref,
    status: "draft",
    signing_mode: "parallel",
    workflow_type,
    completion_mode,
    completion_recipients,
    require_full_read,
    identity_stamp,
    page_count: pdf.numPages,
    storage_path,
    current_storage_path: storage_path,
    owner_id: S.session?.user.id,
  };
  if (!S.demo) {
    check(await supabase.from("signatureflow_documents").insert(doc));
    try {
      check(
        await supabase.storage
          .from("signatureflow-documents")
          .upload(storage_path, file, { contentType: "application/pdf" }),
      );
    } catch (e) {
      await supabase.from("signatureflow_documents").delete().eq("id", id);
      throw e;
    }
  }
  S.doc = doc;
  S.pdf = pdf;
  S.bytes = bytes;
  S.signers = [];
  S.fields = [];
  S.audit = [];
  S.page = 1;
  S.selected = null;
  S.links = [];
  S.dirty = false;
  editor();
}
async function openDocument(id) {
  const doc = check(
    await supabase
      .from("signatureflow_documents")
      .select("*")
      .eq("id", id)
      .single(),
  );
  const result = await Promise.all([
    supabase
      .from("signatureflow_signers")
      .select(
        "id,document_id,name,email,role,signing_order,status,signed_at,copy_sent_at",
      )
      .eq("document_id", id)
      .order("signing_order"),
    supabase
      .from("signatureflow_signature_fields")
      .select("*")
      .eq("document_id", id)
      .order("page"),
    supabase
      .from("signatureflow_audit_events")
      .select("*")
      .eq("document_id", id)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("signatureflow_contacts").select("*").order("name"),
  ]);
  const blob = check(
      await supabase.storage
        .from("signatureflow-documents")
        .download(doc.current_storage_path),
    ),
    bytes = await blob.arrayBuffer(),
    pdf = await pdfjs.getDocument({ ...pdfOptions, data: bytes.slice(0) })
      .promise;
  await S.pdf?.destroy();
  S.doc = doc;
  S.bytes = bytes;
  S.pdf = pdf;
  S.signers = check(result[0]);
  S.fields = check(result[1]).map((f) => ({ ...f, confirmed: true }));
  S.audit = check(result[2]);
  S.contacts = check(result[3]);
  S.page = 1;
  S.selected = null;
  S.links = [];
  S.dirty = false;
  editor();
}
function signerOptions(current = "", empty = true) {
  return (
    (empty ? '<option value="">Choisir un signataire…</option>' : "") +
    S.signers
      .map(
        (s) =>
          `<option value="${s.id}" ${s.id === current ? "selected" : ""}>${esc(s.name)}</option>`,
      )
      .join("")
  );
}
function kindOptions(current = "signature") {
  return Object.entries(kinds)
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === current ? "selected" : ""}>${v}</option>`,
    )
    .join("");
}
function editor() {
  const edit = editable();
  const contactOptions =
      '<option value="">Saisie manuelle…</option>' +
      S.contacts
        .map(
          (contact) =>
            `<option value="${contact.id}">${esc(contact.name)} · ${esc(contact.role || contact.email)}</option>`,
        )
        .join(""),
    completionRecipients = (S.doc.completion_recipients || []).join(", ");
  shell(
    `<main class="editor-shell"><div class="editor-heading"><button class="btn secondary" id="back">← Documents</button><div><h1>${esc(S.doc.name)}</h1><p class="small muted">${esc(S.doc.source_ref || "")} <span class="pill ${S.doc.status}">${statusNames[S.doc.status]}</span></p></div><div class="row"><button class="btn secondary" id="download">↓ PDF</button>${!S.demo ? '<button class="btn secondary" id="refresh">Actualiser</button>' : ""}</div></div><div class="editor-grid"><aside class="card preparation stack"><span class="eyebrow">01 · LES DESTINATAIRES</span><h2>Qui doit signer ?</h2><div id="signerList" class="stack"></div>${edit ? `<form id="signerForm" class="stack"><label>Contact enregistré<select id="savedContact">${contactOptions}</select></label><label>Nom et prénom<input id="signerName" required maxlength="160"></label><label>E-mail<input id="signerEmail" required type="email" maxlength="254"></label><label>Fonction dans le document<input id="signerRole" placeholder="Ex. Responsable travaux" maxlength="100"></label><label class="check"><input id="saveContact" type="checkbox" checked>Enregistrer ou actualiser ce contact</label><button class="btn secondary">+ Ajouter ce signataire</button></form><details class="contact-book"><summary>Carnet de contacts · ${S.contacts.length}</summary><div class="stack">${S.contacts.map((contact) => `<div class="contact-row"><span><strong>${esc(contact.name)}</strong><small>${esc(contact.role || contact.email)}</small></span><button class="remove-contact" data-contact="${contact.id}" aria-label="Supprimer ${esc(contact.name)}">×</button></div>`).join("") || '<p class="small muted">Aucun contact enregistré.</p>'}</div></details><hr><label>Ordre de signature<select id="signingMode"><option value="parallel" ${S.doc.signing_mode === "parallel" ? "selected" : ""}>Chacun peut signer dès réception</option><option value="sequential" ${S.doc.signing_mode === "sequential" ? "selected" : ""}>Dans l’ordre des signataires</option></select></label><label>Type de circuit<select id="workflowType"><option value="approval" ${S.doc.workflow_type !== "acknowledgement" ? "selected" : ""}>Validation complète</option><option value="acknowledgement" ${S.doc.workflow_type === "acknowledgement" ? "selected" : ""}>Prise de connaissance</option></select></label><label>Envoi automatique<select id="completionMode"><option value="all_after_complete" ${S.doc.completion_mode === "all_after_complete" ? "selected" : ""}>PDF final après toutes les signatures</option><option value="signer_after_each" ${S.doc.completion_mode === "signer_after_each" ? "selected" : ""}>Copie après chaque prise de connaissance</option><option value="manual" ${S.doc.completion_mode === "manual" ? "selected" : ""}>Envoi manuel uniquement</option></select></label><label>Copies finales supplémentaires<textarea id="completionRecipients" rows="2" maxlength="4000">${esc(completionRecipients)}</textarea></label><label class="check"><input id="requireFullRead" type="checkbox" ${S.doc.require_full_read !== false ? "checked" : ""}>Obliger la consultation de toutes les pages</label><label class="check"><input id="identityStamp" type="checkbox" ${S.doc.identity_stamp !== false ? "checked" : ""}>Inscrire nom et fonction avec la signature</label>` : '<p class="notice small">Le document est figé depuis la création des liens.</p>'}<hr><span class="eyebrow">03 · VALIDATION ET PARTAGE</span>${edit ? `<label class="check review-confirm"><input id="confirmPreparation" type="checkbox" ${S.doc.prepared_at ? "checked" : ""}>J’ai contrôlé l’intégralité du PDF, les noms, fonctions et emplacements</label>` : ""}<button id="shareLinks" class="btn primary" ${S.demo || ["signed", "cancelled"].includes(S.doc.status) ? "disabled" : ""}>${S.doc.status === "draft" ? "Valider et créer les liens" : "Renouveler les liens"}</button><button id="emailLinks" class="btn secondary" ${S.demo || ["signed", "cancelled"].includes(S.doc.status) ? "disabled" : ""}>Valider et envoyer les invitations</button><div id="preparationFeedback" class="stack" role="status" aria-live="polite" hidden></div><div id="linkList" class="stack"></div>${S.demo ? '<p class="small muted">Connectez-vous pour enregistrer un dossier et faire signer votre document.</p>' : ""}${!S.demo && S.doc.status === "in_progress" ? '<button class="btn danger" id="cancelEnvelope">Annuler les liens de ce dossier</button>' : ""}</aside><section class="pdf-column"><div class="card toolbar"><div class="row"><button class="btn secondary icon" id="prev" aria-label="Page précédente">←</button><label class="page-control">Page <input id="pageInput" type="number" min="1" max="${S.pdf.numPages}" value="${S.page}"> / ${S.pdf.numPages}</label><button class="btn secondary icon" id="next" aria-label="Page suivante">→</button></div>${edit ? `<div class="row"><select id="ocrMode" aria-label="Mode OCR"><option value="auto">OCR si PDF scanné</option><option value="always">OCR sur toutes les pages</option><option value="never">Sans OCR</option></select><button class="btn primary" id="analyze">Analyser le PDF</button><button class="btn secondary" id="stopAnalysis" hidden>Arrêter</button></div>` : ""}</div><div id="analysisStatus" class="small muted" aria-live="polite"></div><div id="selectedZoneTools" class="card manual-tools stack" hidden></div><div class="pdf-host" id="pdfHost"></div>${edit ? `<div class="card manual-tools"><span class="eyebrow">AJOUTER UNE NOUVELLE ZONE</span><div class="row"><select id="manualSigner" aria-label="Signataire de la zone">${signerOptions()}</select><select id="manualKind" aria-label="Type de zone">${kindOptions()}</select><button class="btn secondary" id="place">+ Placer sur la page</button></div><p class="small muted">Ces choix concernent la prochaine zone à ajouter. Pour modifier une zone déjà placée, touchez son cadre sur le PDF puis utilisez « Modifier la zone sélectionnée ».</p></div>` : ""}</section><aside class="card review stack"><span class="eyebrow">02 · LES EMPLACEMENTS</span><div class="row between"><h2>Zones du document</h2><span id="zoneCount" class="pill"></span></div><div id="fieldList" class="stack"></div><div id="fieldDetail"></div>${edit ? '<button class="btn primary" id="save">Enregistrer les zones</button><div class="small muted" id="savedState">Zones enregistrées</div>' : ""}<hr><h3>Suivi du dossier</h3><div class="audit-list">${
      S.audit
        .slice(0, 20)
        .map(
          (a) =>
            `<div><strong>${esc({ document_signed: "Signature enregistrée", preparation_confirmed: "Préparation intégralement validée", links_issued: "Liens créés", document_opened: "Document ouvert", invitation_sent: "Invitation envoyée", invitation_queued: "Invitation mise en envoi automatique", email_error: "Échec de l’invitation", completion_copy_sent: "PDF signé envoyé automatiquement", completion_email_error: "Échec de l’envoi du PDF signé", document_cancelled: "Dossier annulé" }[a.event_type] || a.event_type)}</strong><small>${date(a.created_at)}</small></div>`,
        )
        .join("") ||
      '<p class="small muted">Les ouvertures et signatures apparaîtront ici.</p>'
    }</div>${!S.demo ? '<button class="btn secondary" id="auditExport">Exporter les preuves (JSON)</button>' : ""}</aside></div></main>`,
  );
  $("#back").onclick = () => {
    if (S.dirty && !confirm("Quitter sans enregistrer les zones ?")) return;
    analysisController?.abort();
    dashboard();
  };
  $("#download").onclick = () =>
    download(
      new Blob([S.bytes], { type: "application/pdf" }),
      fileName() + ".pdf",
    );
  $("#refresh")?.addEventListener("click", (e) =>
    busy(e.target, () => {
      if (S.dirty && !confirm("Actualiser et abandonner les modifications ?"))
        return;
      return openDocument(S.doc.id);
    }),
  );
  $("#auditExport")?.addEventListener("click", (e) =>
    busy(e.target, async () => {
      const all = [];
      for (let from = 0; ; from += 1000) {
        const rows = check(
          await supabase
            .from("signatureflow_audit_events")
            .select("*")
            .eq("document_id", S.doc.id)
            .order("id")
            .range(from, from + 999),
        );
        all.push(...rows);
        if (rows.length < 1000) break;
      }
      download(
        new Blob(
          [
            JSON.stringify(
              {
                format: "SignatureFlow evidence v2",
                document: S.doc,
                signers: S.signers,
                fields: S.fields,
                events: all,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        fileName() + "-preuves.json",
      );
    }),
  );
  $("#prev").onclick = () => goPage(S.page - 1);
  $("#next").onclick = () => goPage(S.page + 1);
  $("#pageInput").onchange = (e) => goPage(Number(e.target.value));
  if (edit) {
    $("#savedContact").onchange = (e) => {
      const contact = S.contacts.find((item) => item.id === e.target.value);
      if (!contact) return;
      $("#signerName").value = contact.name;
      $("#signerEmail").value = contact.email;
      $("#signerRole").value = contact.role || "";
    };
    $("#signerForm").onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, addSigner);
    };
    document.querySelectorAll(".remove-contact").forEach(
      (button) =>
        (button.onclick = () =>
          busy(button, async () => {
            if (!confirm("Supprimer ce contact du carnet ?")) return;
            check(
              await supabase
                .from("signatureflow_contacts")
                .delete()
                .eq("id", button.dataset.contact),
            );
            S.contacts = S.contacts.filter(
              (contact) => contact.id !== button.dataset.contact,
            );
            editor();
          })),
    );
    $("#signingMode").onchange = (e) =>
      busy(null, async () => {
        const signing_mode = e.target.value;
        if (!S.demo)
          check(
            await supabase
              .from("signatureflow_documents")
              .update({ signing_mode })
              .eq("id", S.doc.id),
          );
        S.doc.signing_mode = signing_mode;
        S.doc.prepared_at = null;
        if ($("#confirmPreparation")) $("#confirmPreparation").checked = false;
      });
    const saveWorkflow = async () => {
      const completion_recipients = $("#completionRecipients")
        .value.split(/[;,\n]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        completion_recipients.some(
          (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        )
      )
        throw new Error("Une adresse de copie finale est invalide.");
      const settings = {
        workflow_type: $("#workflowType").value,
        completion_mode: $("#completionMode").value,
        completion_recipients,
        require_full_read: $("#requireFullRead").checked,
        identity_stamp: $("#identityStamp").checked,
      };
      if (!S.demo)
        check(
          await supabase
            .from("signatureflow_documents")
            .update(settings)
            .eq("id", S.doc.id),
        );
      Object.assign(S.doc, settings, { prepared_at: null });
      $("#confirmPreparation").checked = false;
      notify("Configuration du circuit enregistrée.", "success");
    };
    $("#workflowType").onchange = (e) => {
      $("#completionMode").value =
        e.target.value === "acknowledgement"
          ? "signer_after_each"
          : "all_after_complete";
      busy(null, saveWorkflow);
    };
    [
      "#completionMode",
      "#completionRecipients",
      "#requireFullRead",
      "#identityStamp",
    ].forEach((selector) => {
      $(selector).onchange = () => busy(null, saveWorkflow);
    });
    $("#analyze").onclick = (e) => busy(e.target, runAnalysis);
    $("#stopAnalysis").onclick = () => analysisController?.abort();
    $("#save").onclick = (e) => busy(e.target, saveFields);
    $("#place").onclick = () => {
      if (!$("#manualSigner").value)
        return notify("Choisissez d’abord le signataire.", "warning");
      S.placing = {
        signer: $("#manualSigner").value,
        kind: $("#manualKind").value,
      };
      $("#pdfHost").classList.add("placing");
      notify("Cliquez à l’emplacement souhaité dans la page.");
    };
  }
  $("#shareLinks").onclick = (e) => busy(e.target, () => issueLinks("links"));
  $("#emailLinks").onclick = (e) => busy(e.target, () => issueLinks("email"));
  $("#cancelEnvelope")?.addEventListener("click", (e) => {
    if (confirm("Annuler ce dossier et désactiver ses liens personnels ?"))
      busy(e.target, async () => {
        await invoke("signatureflow-invite-signer", {
          documentId: S.doc.id,
          action: "cancel",
        });
        await openDocument(S.doc.id);
      });
  });
  if (S.dirty && $("#savedState"))
    $("#savedState").textContent = "Modifications à enregistrer";
  drawSigners();
  drawFields();
  drawPage();
  resizeObserver = new ResizeObserver(() => {
    clearTimeout(S.resizeTimer);
    S.resizeTimer = setTimeout(() => drawPage(), 180);
  });
  resizeObserver.observe($("#pdfHost"));
}
function drawSigners() {
  $("#signerList").innerHTML =
    S.signers
      .map(
        (s, i) =>
          `<div class="signer-item" style="--signer-color:${["#3563e9", "#a34ab9", "#168476", "#b2781c"][i % 4]}"><span class="avatar">${esc(s.name.slice(0, 1))}</span><div><strong>${esc(s.name)}</strong><small>${esc(s.role || s.email)}</small><span class="small">${i + 1} · ${statusNames[s.status || "pending"]}${s.copy_sent_at ? " · copie envoyée" : ""}</span></div>${editable() ? `<button class="remove-signer" data-id="${s.id}" aria-label="Retirer ${esc(s.name)}">×</button>` : ""}</div>`,
      )
      .join("") ||
    '<p class="small muted">Ajoutez les personnes qui doivent lire et signer ce document.</p>';
  document.querySelectorAll(".remove-signer").forEach(
    (el) =>
      (el.onclick = () =>
        busy(el, async () => {
          if (!S.demo)
            check(
              await supabase
                .from("signatureflow_signers")
                .delete()
                .eq("id", el.dataset.id),
            );
          S.signers = S.signers.filter((s) => s.id !== el.dataset.id);
          S.fields = S.fields.filter((f) => f.signer_id !== el.dataset.id);
          dirty();
          editor();
        })),
  );
}
async function addSigner() {
  const name = $("#signerName").value.trim(),
    email = $("#signerEmail").value.trim().toLowerCase(),
    role = $("#signerRole").value.trim();
  if (S.signers.some((s) => s.email === email))
    throw new Error("Cette adresse figure déjà dans les signataires.");
  if (S.signers.length >= 40)
    throw new Error("Un dossier est limité à 40 signataires.");
  if (!role)
    throw new Error(
      "Renseignez la fonction de la personne pour l’identifier précisément dans le document.",
    );
  if ($("#saveContact")?.checked) {
    const existing = S.contacts.find(
      (contact) => contact.email.toLowerCase() === email,
    );
    if (!S.demo) {
      if (existing)
        check(
          await supabase
            .from("signatureflow_contacts")
            .update({ name, role, updated_at: new Date().toISOString() })
            .eq("id", existing.id),
        );
      else {
        const saved = check(
          await supabase
            .from("signatureflow_contacts")
            .insert({ owner_id: S.session.user.id, name, email, role })
            .select()
            .single(),
        );
        S.contacts.push(saved);
      }
    }
    if (existing) Object.assign(existing, { name, role });
    else if (S.demo)
      S.contacts.push({ id: uuid(), owner_id: "demo", name, email, role });
    S.contacts.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }
  const signer = {
    id: uuid(),
    document_id: S.doc.id,
    name,
    email,
    role,
    signing_order: Math.max(0, ...S.signers.map((s) => s.signing_order)) + 1,
  };
  if (!S.demo)
    check(await supabase.from("signatureflow_signers").insert(signer));
  S.signers.push({ ...signer, status: "pending" });
  S.doc.prepared_at = null;
  editor();
}
function goPage(p) {
  if (!Number.isInteger(p) || p < 1 || p > S.pdf.numPages) return;
  S.page = p;
  $("#pageInput").value = p;
  drawPage();
}
async function drawPage() {
  const id = ++S.renderId,
    host = $("#pdfHost");
  if (!host || !S.pdf) return;
  renderTask?.cancel();
  const page = await S.pdf.getPage(S.page);
  if (id !== S.renderId) return;
  const width = Math.max(220, host.clientWidth - 32),
    viewport = page.getViewport({
      scale: width / page.getViewport({ scale: 1 }).width,
    });
  host.innerHTML =
    '<div id="stage" class="pdf-stage"><canvas></canvas><div class="overlays"></div></div>';
  const stage = $("#stage"),
    canvas = stage.querySelector("canvas"),
    ratio = Math.min(devicePixelRatio || 1, 2);
  stage.style.width = viewport.width + "px";
  stage.style.height = viewport.height + "px";
  canvas.width = Math.ceil(viewport.width * ratio);
  canvas.height = Math.ceil(viewport.height * ratio);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  renderTask = page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: [ratio, 0, 0, ratio, 0, 0],
  });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e.name === "RenderingCancelledException") return;
    throw e;
  }
  if (id !== S.renderId) return;
  drawOverlays();
  stage.onclick = (e) => {
    if (!S.placing || !editable()) return;
    const r = stage.getBoundingClientRect(),
      f = bounded({
        id: uuid(),
        document_id: S.doc.id,
        signer_id: S.placing.signer,
        page: S.page,
        kind: S.placing.kind,
        x: (e.clientX - r.left) / r.width,
        y: (e.clientY - r.top) / r.height,
        width: S.placing.kind === "checkbox" ? 0.035 : 0.28,
        height:
          S.placing.kind === "checkbox"
            ? 0.025
            : ["signature", "initials"].includes(S.placing.kind)
              ? 0.075
              : 0.035,
        label: kinds[S.placing.kind],
        required: true,
        confirmed: true,
        detection_source: "manual",
      });
    S.fields.push(f);
    S.selected = f.id;
    S.placing = null;
    host.classList.remove("placing");
    dirty();
    drawFields();
    drawOverlays();
  };
}
function drawOverlays() {
  const stage = $("#stage"),
    layer = stage?.querySelector(".overlays");
  if (!layer) return;
  layer.innerHTML = "";
  for (const f of S.fields.filter((f) => f.page === S.page)) {
    const signer = S.signers.find((s) => s.id === f.signer_id),
      el = document.createElement("div");
    el.className = `sig-field ${f.id === S.selected ? "active" : ""} ${f.confirmed ? "" : "unconfirmed"}`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute(
      "aria-label",
      `${kinds[f.kind]} : ${signer?.name || "À attribuer"}`,
    );
    const position = () => {
      Object.assign(el.style, {
        left: f.x * 100 + "%",
        top: f.y * 100 + "%",
        width: f.width * 100 + "%",
        height: f.height * 100 + "%",
      });
    };
    position();
    el.innerHTML = `<span>${esc(signer?.name || "À attribuer")}<small>${esc(kinds[f.kind])}</small></span>${editable() ? '<i class="resize-handle" aria-hidden="true"></i>' : ""}`;
    el.onclick = (e) => {
      e.stopPropagation();
      S.selected = f.id;
      drawFields();
      drawOverlays();
    };
    if (editable()) {
      el.onpointerdown = (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const start = { ...f },
          x = e.clientX,
          y = e.clientY,
          r = stage.getBoundingClientRect(),
          resize = e.target.classList.contains("resize-handle");
        el.setPointerCapture(e.pointerId);
        el.onpointermove = (ev) => {
          const dx = (ev.clientX - x) / r.width,
            dy = (ev.clientY - y) / r.height;
          Object.assign(
            f,
            bounded({
              ...start,
              ...(resize
                ? { width: start.width + dx, height: start.height + dy }
                : { x: start.x + dx, y: start.y + dy }),
            }),
          );
          position();
        };
        el.onpointerup = () => {
          el.onpointermove = null;
          S.selected = f.id;
          dirty();
          drawFields();
          drawOverlays();
        };
      };
      el.onkeydown = (e) => {
        if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          Object.assign(
            f,
            bounded({
              ...f,
              x:
                f.x +
                (e.key === "ArrowLeft"
                  ? -0.002
                  : e.key === "ArrowRight"
                    ? 0.002
                    : 0),
              y:
                f.y +
                (e.key === "ArrowUp"
                  ? -0.002
                  : e.key === "ArrowDown"
                    ? 0.002
                    : 0),
            }),
          );
          dirty();
          position();
        }
        if (e.key === "Delete") {
          S.fields = S.fields.filter((v) => v.id !== f.id);
          dirty();
          drawFields();
          drawOverlays();
        }
      };
    }
    layer.append(el);
  }
}
function drawFields() {
  $("#zoneCount").textContent = S.fields.length;
  $("#fieldList").innerHTML =
    S.fields
      .map((f) => {
        const s = S.signers.find((s) => s.id === f.signer_id);
        return `<button class="zone-item ${f.id === S.selected ? "selected" : ""}" data-field="${f.id}"><span>${esc(s?.name || "À attribuer")}<small>${esc(kinds[f.kind])} · page ${f.page}${f.confidence != null ? " · indice " + Math.round(f.confidence * 100) + " %" : ""}</small></span><span>${f.confirmed ? "✓" : "!"}</span></button>`;
      })
      .join("") ||
    '<div class="empty small"><p>Lancez l’analyse du PDF ou placez une zone manuellement.</p></div>';
  document.querySelectorAll("[data-field]").forEach(
    (el) =>
      (el.onclick = () => {
        S.selected = el.dataset.field;
        const f = S.fields.find((f) => f.id === S.selected);
        goPage(f.page);
        drawFields();
      }),
  );
  const f = S.fields.find((f) => f.id === S.selected);
  const selectedTools = $("#selectedZoneTools");
  if (selectedTools) {
    selectedTools.hidden = !f || !editable();
    selectedTools.innerHTML =
      f && editable()
        ? `<strong>Modifier la zone sélectionnée · page ${f.page}</strong><label>Signataire de cette zone<select id="selectedSigner">${signerOptions(f.signer_id)}</select></label><label>Type de cette zone<select id="selectedKind">${kindOptions(f.kind)}</select></label><p class="small muted">Ces réglages modifient directement le cadre sélectionné sur le PDF.</p>`
        : "";
    if (f && editable()) {
      $("#selectedSigner").onchange = (e) => {
        f.signer_id = e.target.value || null;
        dirty();
        drawFields();
        drawOverlays();
      };
      $("#selectedKind").onchange = (e) => {
        f.kind = e.target.value;
        dirty();
        drawFields();
        drawOverlays();
      };
    }
  }
  $("#fieldDetail").innerHTML =
    f && editable()
      ? `<div class="field-settings stack"><strong>Modifier cette zone</strong><p class="small muted">${esc(f.label || "Zone manuelle")}<br>${esc(f.detection_source || "")}</p><label>Signataire<select id="fieldSigner">${signerOptions(f.signer_id)}</select></label><label>Type<select id="fieldKind">${kindOptions(f.kind)}</select></label><label>Libellé<input id="fieldLabel" value="${esc(f.label)}" maxlength="160"></label><label class="check"><input type="checkbox" id="fieldRequired" ${f.required ? "checked" : ""}>Champ obligatoire</label><label class="check"><input id="fieldConfirmed" type="checkbox" ${f.confirmed ? "checked" : ""}>Position et attribution vérifiées</label><button class="btn danger" id="deleteField">Supprimer la zone</button></div>`
      : "";
  if (f && editable()) {
    const change = () => {
      f.signer_id = $("#fieldSigner").value || null;
      f.kind = $("#fieldKind").value;
      f.label = $("#fieldLabel").value;
      f.required = $("#fieldRequired").checked;
      f.confirmed = $("#fieldConfirmed").checked;
      dirty();
      drawOverlays();
    };
    [
      "#fieldSigner",
      "#fieldKind",
      "#fieldLabel",
      "#fieldRequired",
      "#fieldConfirmed",
    ].forEach(
      (s) =>
        ($(s).onchange = () => {
          change();
          drawFields();
        }),
    );
    $("#deleteField").onclick = () => {
      S.fields = S.fields.filter((v) => v.id !== f.id);
      dirty();
      drawFields();
      drawOverlays();
    };
  }
}
async function runAnalysis() {
  analysisController = new AbortController();
  $("#stopAnalysis").hidden = false;
  try {
    const result = await analyzePdf(S.pdf, S.signers, {
      ocrMode: $("#ocrMode").value,
      signal: analysisController.signal,
      onProgress: (message) => {
        $("#analysisStatus").textContent = message;
      },
    });
    let added = 0;
    for (const c of result.candidates) {
      if (S.fields.some((f) => f.page === c.page && overlap(f, c) > 0.5))
        continue;
      S.fields.push({
        ...c,
        id: uuid(),
        document_id: S.doc.id,
        signer_id: c.suggested_signer_id,
        required: true,
        confirmed: false,
        detection_source: c.reason,
      });
      added++;
    }
    if (added) {
      dirty();
      S.selected = S.fields.find((f) => !f.confirmed)?.id;
      goPage(S.fields.find((f) => f.id === S.selected)?.page || S.page);
    }
    drawFields();
    drawOverlays();
    $("#analysisStatus").textContent =
      `${added} proposition(s) ajoutée(s) · ${result.pages} page(s) · ${result.ocrPages} page(s) OCR. ${result.warnings.join(" ")}`;
    notify(
      added
        ? "Sélectionnez chaque proposition, attribuez-la et cochez « Position et attribution vérifiées »."
        : "Aucune nouvelle zone trouvée. Vous pouvez placer les zones manuellement.",
      added ? "success" : "warning",
    );
  } catch (e) {
    if (e.name === "AbortError")
      notify("Analyse arrêtée. Les zones déjà présentes sont conservées.");
    else throw e;
  } finally {
    $("#stopAnalysis").hidden = true;
    analysisController = null;
  }
}
function preparationError(message, field, signer) {
  const error = new Error(message);
  error.fieldId = field?.id;
  error.signerId = signer?.id;
  return error;
}
function preparationFeedback(message, type = "notice") {
  const panel = $("#preparationFeedback");
  if (!panel) return;
  panel.hidden = false;
  panel.className = `stack ${type}`;
  panel.replaceChildren(document.createTextNode(message));
  return panel;
}
function showPreparationError(error) {
  const panel = preparationFeedback(
    error.message || "Création des liens interrompue. Réessayez.",
    "error",
  );
  if (!panel) return;
  const field = S.fields.find((f) => f.id === error.fieldId);
  const signer = S.signers.find((s) => s.id === error.signerId);
  if (signer) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn secondary";
    add.textContent = `Ajouter une zone Signature pour ${signer.name}`;
    add.onclick = () => {
      S.placing = { signer: signer.id, kind: "signature" };
      $("#pdfHost").classList.add("placing");
      $("#pdfHost").scrollIntoView({ block: "center" });
      notify("Touchez une zone libre du PDF pour placer la signature.");
    };
    panel.append(add);
    if (field && !["signature", "initials"].includes(field.kind)) {
      const convert = document.createElement("button");
      convert.type = "button";
      convert.className = "btn secondary";
      convert.textContent = `Transformer « ${kinds[field.kind]} » (page ${field.page}) en zone Signature pour ${signer.name}`;
      convert.onclick = () => {
        field.kind = "signature";
        field.label = kinds.signature;
        Object.assign(
          field,
          bounded({ ...field, height: Math.max(field.height, 0.075) }),
        );
        S.placing = null;
        $("#pdfHost").classList.remove("placing");
        S.selected = field.id;
        dirty();
        goPage(field.page);
        drawFields();
        $("#selectedZoneTools").scrollIntoView({ block: "center" });
        preparationFeedback(
          "Zone transformée en Signature. Vérifiez son emplacement, puis cochez le contrôle du PDF et relancez la création des liens.",
          "success",
        );
      };
      panel.append(convert);
    }
  }
  panel.scrollIntoView({ block: "center" });
}
function validateDraft() {
  if (!S.signers.length) throw new Error("Ajoutez au moins un signataire.");
  if (!S.fields.length)
    throw preparationError(
      "Ajoutez une zone de signature sur le PDF pour chaque signataire.",
      null,
      S.signers[0],
    );
  const unreviewed = S.fields.find((f) => !f.signer_id || !f.confirmed);
  if (unreviewed)
    throw preparationError(
      `Attribuez et vérifiez la zone « ${kinds[unreviewed.kind]} » de la page ${unreviewed.page} avant d’enregistrer.`,
      unreviewed,
    );
  for (const signer of S.signers) {
    if (
      S.fields.some(
        (f) =>
          f.signer_id === signer.id &&
          ["signature", "initials"].includes(f.kind),
      )
    )
      continue;
    const assigned = S.fields.filter((f) => f.signer_id === signer.id);
    const field = assigned.find((f) => f.id === S.selected) || assigned[0];
    throw preparationError(
      `Il manque une zone de signature ou de paraphe pour ${signer.name}.${field ? ` La zone « ${kinds[field.kind]} » de la page ${field.page} doit être complétée par une signature, ou transformée avec le bouton ci-dessous.` : ""}`,
      field,
      signer,
    );
  }
}
async function saveFields() {
  validateDraft();
  if (!S.demo) {
    const fields = S.fields.map(
      ({
        id,
        signer_id,
        page,
        x,
        y,
        width,
        height,
        kind,
        label,
        required,
        confidence,
        detection_source,
      }) => ({
        id,
        signer_id,
        page,
        x,
        y,
        width,
        height,
        kind,
        label,
        required,
        confidence,
        detection_source,
      }),
    );
    check(
      await supabase.rpc("signatureflow_save_fields", {
        p_document: S.doc.id,
        p_fields: fields,
      }),
    );
  }
  S.dirty = false;
  $("#savedState").textContent = S.demo
    ? "Zones validées pour cet essai local"
    : "Toutes les zones sont enregistrées";
  notify(
    S.demo
      ? "Zones validées dans l’essai. Connectez-vous pour créer un dossier partagé."
      : "Zones enregistrées. Vous pouvez créer les liens personnels.",
    "success",
  );
}
async function issueLinks(delivery) {
  if (S.demo) return;
  preparationFeedback("Vérification du dossier…");
  if (editable()) {
    if (!$("#confirmPreparation")?.checked)
      throw new Error(
        "Confirmez avoir contrôlé toutes les pages, les identités et les emplacements avant l’envoi.",
      );
    preparationFeedback("Enregistrement des zones de signature…");
    await saveFields();
    preparationFeedback("Validation de la préparation…");
    S.doc.prepared_at = check(
      await supabase.rpc("signatureflow_confirm_preparation", {
        p_document: S.doc.id,
      }),
    );
  } else if (
    !confirm(
      "Renouveler les liens des signataires en attente ? Leurs anciens liens seront désactivés.",
    )
  )
    return;
  preparationFeedback(
    delivery === "email"
      ? "Création des liens et envoi des invitations…"
      : "Création des liens personnels…",
  );
  const result = await invoke("signatureflow-invite-signer", {
    documentId: S.doc.id,
    appUrl: APP_URL,
    delivery,
  });
  const links = result.links;
  await openDocument(S.doc.id);
  S.links = links;
  renderLinks();
  preparationFeedback("Les liens personnels sont prêts ci-dessous.", "success");
  $("#linkList").scrollIntoView({ block: "center" });
  notify(
    result.queued
      ? "Invitations mises en envoi automatique. Le suivi de remise est disponible dans Documents, versions et diffusions."
      : delivery === "email"
        ? `${result.sent}/${links.length} invitation(s) envoyée(s). Les liens restent disponibles ci-dessous.`
        : "Les liens personnels sont prêts à partager. Le document est maintenant figé.",
    "success",
  );
}
function renderLinks() {
  $("#linkList").innerHTML = S.links
    .map(
      (l, i) =>
        `<div class="link-card stack"><strong>${esc(l.name)}</strong><small>${esc(l.role || "Signataire")} · ${esc(l.email)}</small><span class="small ${l.error ? "error" : "muted"}">${esc(l.error || (l.sent ? "Invitation envoyée" : "Lien prêt"))} · expire le ${date(l.expires)}</span><div class="row"><button class="btn secondary" data-copy="${i}">Copier</button><button class="btn secondary" data-share="${i}">Partager</button><a class="btn secondary" href="${esc("mailto:" + l.email + "?subject=" + encodeURIComponent("Document à signer — " + S.doc.name) + "&body=" + encodeURIComponent(`Bonjour ${l.name},\nVous êtes identifié comme ${l.role || "signataire"}.\nMerci de consulter et signer « ${S.doc.name} » via votre lien personnel :\n${l.url}\nCe lien est valable 14 jours.`))}">E-mail</a></div></div>`,
    )
    .join("");
  document.querySelectorAll("[data-copy]").forEach(
    (el) =>
      (el.onclick = () =>
        busy(el, async () => {
          await navigator.clipboard.writeText(S.links[el.dataset.copy].url);
          notify(
            "Lien copié. Vous pouvez le coller dans Journal de Chantier.",
            "success",
          );
        })),
  );
  document.querySelectorAll("[data-share]").forEach(
    (el) =>
      (el.onclick = () =>
        busy(el, async () => {
          const l = S.links[el.dataset.share];
          if (navigator.share)
            await navigator.share({
              title: S.doc.name,
              text: `${l.name}, voici votre document à lire et signer.`,
              url: l.url,
            });
          else {
            await navigator.clipboard.writeText(l.url);
            notify("Lien copié.");
          }
        })),
  );
}
function exitSigning() {
  sessionStorage.removeItem("signatureflow_sign_token");
  history.replaceState({}, "", location.pathname);
  location.reload();
}
async function signingPage(token) {
  if (!supabase) {
    login();
    return notify("Le service de signature doit être configuré.", "warning");
  }
  shell(
    '<main class="sign-page"><div class="card">Chargement de votre document…</div></main>',
  );
  let data;
  try {
    data = await invoke("signatureflow-get-signing-context", { token });
  } catch (e) {
    shell(
      `<main class="sign-page"><div class="card stack"><h1>Lien indisponible</h1><p>${esc(e.message)}</p><p>Demandez un nouveau lien à l’organisateur du document.</p><button class="btn secondary" id="exitSigning">Quitter</button></div></main>`,
    );
    $("#exitSigning").onclick = exitSigning;
    return;
  }
  const already = data.signer.status === "signed",
    viewedPages = new Set(),
    identity = `${data.signer.name}${data.signer.role ? ` · ${data.signer.role}` : ""}`,
    consentText =
      data.document.workflowType === "acknowledgement"
        ? `Je confirme avoir consulté l’intégralité du document « ${esc(data.document.name)} » et en avoir pris connaissance.`
        : `Je confirme avoir consulté l’intégralité du document « ${esc(data.document.name)} » et j’accepte d’y apposer cette signature électronique.`;
  shell(
    `<main class="sign-page stack"><section class="card sign-intro"><div><span class="eyebrow">${already ? "SIGNATURE ENREGISTRÉE" : data.document.workflowType === "acknowledgement" ? "PRISE DE CONNAISSANCE" : "VOTRE DOCUMENT À SIGNER"}</span><h1>${esc(data.document.name)}</h1><div class="signer-identity"><span class="avatar">${esc(data.signer.name.slice(0, 1))}</span><span><strong>${esc(data.signer.name)}</strong><small>${esc(data.signer.role || "Fonction non précisée")} · ${esc(data.signer.email)}</small></span></div><p>${already ? "Votre signature a bien été enregistrée." : "Votre nom et votre fonction sont déjà associés aux zones qui vous sont attribuées."}</p></div><button class="btn secondary" id="exitSigning">Quitter</button></section>${data.blocked ? '<div class="warning">Un signataire précédent doit encore signer. Vous pouvez lire le document et revenir avec ce même lien.<button class="btn secondary" id="retry">Actualiser</button></div>' : ""}<section class="card stack"><div class="row between"><div class="row"><button class="btn secondary" id="signPrev">←</button><strong id="signPageLabel"></strong><button class="btn secondary" id="signNext">→</button></div><a class="btn secondary" href="${esc(data.document.signedUrl)}" target="_blank" rel="noopener noreferrer">Ouvrir le PDF</a></div><div class="reading-progress"><span id="readingProgress">Pages consultées : 0 / ${data.document.pageCount}</span><progress id="readingBar" max="${data.document.pageCount}" value="0"></progress></div><div id="signPdfHost" class="pdf-host"></div><button class="btn secondary" id="nextZone">Aller à ma prochaine zone</button></section>${
      !already && !data.blocked
        ? `<section class="card stack" id="signForm"><span class="eyebrow">À VOUS DE SIGNER</span><h2>${esc(identity)}</h2><p class="notice small">Le nom et la fonction ci-dessus seront inscrits avec votre signature dans le PDF.</p><label>Identité attribuée<input id="typedName" value="${esc(data.signer.name)}" required readonly maxlength="160" autocomplete="name"></label>${data.fields
            .filter((f) => ["text", "checkbox"].includes(f.kind))
            .map((f) =>
              f.kind === "checkbox"
                ? `<label class="check"><input data-value="${f.id}" type="checkbox" ${f.required ? "required" : ""}>${esc(f.label || "Case à cocher")} ${f.required ? "*" : ""} · page ${f.page}</label>`
                : `<label>${esc(f.label || "Texte à compléter")} ${f.required ? "*" : ""} · page ${f.page}<input data-value="${f.id}" maxlength="500" ${f.required ? "required" : ""}></label>`,
            )
            .join(
              "",
            )}<label>Tracez votre signature<div class="signature-box"><canvas id="signatureCanvas" aria-label="Zone de dessin de la signature"></canvas></div></label><button class="btn secondary fit" id="clearSignature">Effacer la signature</button>${data.fields.some((f) => f.kind === "initials") ? '<label>Tracez vos initiales<div class="signature-box"><canvas id="initialsCanvas" aria-label="Zone de dessin des initiales"></canvas></div></label><button class="btn secondary fit" id="clearInitials">Effacer les initiales</button>' : ""}<label class="check consent"><input id="consent" type="checkbox"><span>${consentText}</span></label><button class="btn primary" id="submitSignature" ${data.document.requireFullRead ? "disabled" : ""}>${data.document.workflowType === "acknowledgement" ? "Confirmer ma prise de connaissance" : "Confirmer et signer le document"}</button><p class="notice small" id="signingGate" role="status"></p><button type="button" class="btn secondary" id="goUnread" hidden>Consulter la prochaine page non lue</button><p class="small muted">Cette signature utilise le lien personnel envoyé à ${esc(data.signer.email)} et votre consentement. Elle ne comporte pas de vérification de pièce d’identité.</p></section>`
        : already
          ? '<div class="success">Votre signature est enregistrée. Le PDF accessible ci-dessus contient la dernière version disponible.</div>'
          : ""
    }</main>`,
  );
  $("#exitSigning").onclick = exitSigning;
  $("#retry")?.addEventListener("click", () => signingPage(token));
  const response = await fetch(data.document.signedUrl);
  if (!response.ok) throw new Error("Accès au PDF expiré. Rechargez la page.");
  const bytes = await response.arrayBuffer(),
    actual = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
  if (actual !== data.document.sha256)
    throw new Error(
      "L’empreinte du PDF ne correspond pas. Rechargez le document.",
    );
  const pdf = await pdfjs.getDocument({ ...pdfOptions, data: bytes }).promise;
  let pageNum = 1,
    zoneIndex = -1,
    signRender = 0;
  const updateReading = () => {
    if ($("#readingProgress"))
      $("#readingProgress").textContent = data.document.requireFullRead
        ? `Pages consultées : ${viewedPages.size} / ${pdf.numPages}`
        : `Lecture intégrale recommandée · ${viewedPages.size} / ${pdf.numPages}`;
    if ($("#readingBar")) $("#readingBar").value = viewedPages.size;
    const remaining = pdf.numPages - viewedPages.size;
    if ($("#signingGate"))
      $("#signingGate").textContent =
        data.document.requireFullRead && remaining > 0
          ? `Il reste ${remaining} page(s) à consulter sur ${pdf.numPages} avant de pouvoir signer.`
          : "Toutes les pages requises ont été consultées. Vérifiez votre signature puis confirmez votre consentement.";
    if ($("#goUnread"))
      $("#goUnread").hidden = !data.document.requireFullRead || remaining === 0;
    if ($("#submitSignature"))
      $("#submitSignature").disabled =
        data.document.requireFullRead && viewedPages.size < pdf.numPages;
  };
  const draw = async () => {
    const seq = ++signRender,
      page = await pdf.getPage(pageNum),
      host = $("#signPdfHost");
    if (seq !== signRender || !host) return;
    const vp = page.getViewport({
        scale:
          Math.max(220, host.clientWidth - 32) /
          page.getViewport({ scale: 1 }).width,
      }),
      stage = document.createElement("div"),
      canvas = document.createElement("canvas"),
      dpr = Math.min(devicePixelRatio || 1, 2);
    stage.className = "pdf-stage";
    stage.style.width = vp.width + "px";
    stage.style.height = vp.height + "px";
    canvas.width = vp.width * dpr;
    canvas.height = vp.height * dpr;
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    stage.append(canvas);
    host.replaceChildren(stage);
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: [dpr, 0, 0, dpr, 0, 0],
    }).promise;
    if (seq !== signRender) return;
    viewedPages.add(pageNum);
    updateReading();
    data.fields
      .filter((f) => f.page === pageNum)
      .forEach((f) => {
        const o = document.createElement("button");
        o.className = "signature-overlay";
        Object.assign(o.style, {
          left: f.x * 100 + "%",
          top: f.y * 100 + "%",
          width: f.width * 100 + "%",
          height: f.height * 100 + "%",
        });
        o.textContent =
          f.kind === "signature" || f.kind === "initials"
            ? `${data.signer.name}${data.signer.role ? ` · ${data.signer.role}` : ""}`
            : kinds[f.kind];
        o.onclick = () =>
          $("#signForm")?.scrollIntoView({ behavior: "smooth" });
        stage.append(o);
      });
    $("#signPageLabel").textContent = `Page ${pageNum} / ${pdf.numPages}`;
    $("#signPrev").disabled = pageNum === 1;
    $("#signNext").disabled = pageNum === pdf.numPages;
  };
  $("#signPrev").onclick = () => {
    if (pageNum > 1) {
      pageNum--;
      draw();
    }
  };
  $("#signNext").onclick = () => {
    if (pageNum < pdf.numPages) {
      pageNum++;
      draw();
    }
  };
  $("#nextZone").onclick = () => {
    if (!data.fields.length) return;
    zoneIndex = (zoneIndex + 1) % data.fields.length;
    pageNum = data.fields[zoneIndex].page;
    draw();
    $("#signPdfHost").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  $("#goUnread")?.addEventListener("click", () => {
    for (let p = 1; p <= pdf.numPages; p++)
      if (!viewedPages.has(p)) {
        pageNum = p;
        break;
      }
    draw();
    $("#signPdfHost").scrollIntoView({ block: "start", behavior: "smooth" });
  });
  await draw();
  const observed = new ResizeObserver(() => {
    clearTimeout(S.signResize);
    S.signResize = setTimeout(draw, 180);
  });
  observed.observe($("#signPdfHost"));
  resizeObserver = observed;
  if (already || data.blocked) return;
  const makePad = (id) => {
    const c = $(id),
      pad = new SignaturePad(c, { minWidth: 0.7, maxWidth: 2.2 });
    let previousWidth = 0;
    const resize = () => {
      const strokes = pad.toData(),
        width = c.clientWidth;
      if (!width || c.width === Math.round(width * devicePixelRatio)) return;
      c.width = Math.round(width * devicePixelRatio);
      c.height = Math.round(180 * devicePixelRatio);
      c.getContext("2d").scale(devicePixelRatio, devicePixelRatio);
      pad.clear();
      if (strokes.length) {
        const scale = previousWidth ? width / previousWidth : 1;
        const adjusted = strokes.map((group) => ({
          ...group,
          points: group.points.map((point) => ({
            ...point,
            x: point.x * scale,
          })),
        }));
        pad.fromData(adjusted);
      }
      previousWidth = width;
    };
    resize();
    observed.observe(c);
    const handler = new ResizeObserver(resize);
    handler.observe(c);
    pad._observer = handler;
    pads.push(pad);
    return pad;
  };
  const pad = makePad("#signatureCanvas"),
    initialPad = $("#initialsCanvas") ? makePad("#initialsCanvas") : null;
  $("#clearSignature").onclick = () => pad.clear();
  $("#clearInitials")?.addEventListener("click", () => initialPad.clear());
  const requestId = uuid();
  $("#submitSignature").onclick = (e) =>
    busy(e.target, async () => {
      if (data.document.requireFullRead && viewedPages.size < pdf.numPages)
        throw new Error(
          `Consultez toutes les pages avant de signer (${viewedPages.size}/${pdf.numPages}).`,
        );
      if (pad.isEmpty() || (initialPad && initialPad.isEmpty()))
        throw new Error(
          "Tracez votre signature et vos initiales si demandées.",
        );
      if (!$("#consent").checked)
        throw new Error(
          "Confirmez votre lecture et votre consentement avant de signer.",
        );
      const inputs = [...document.querySelectorAll("#signForm input")];
      if (inputs.some((i) => !i.checkValidity())) {
        inputs.find((i) => !i.checkValidity()).reportValidity();
        return;
      }
      const typedName = $("#typedName").value.trim();
      if (typedName.length < 2)
        throw new Error("Renseignez votre nom et prénom.");
      const values = Object.fromEntries(
        [...document.querySelectorAll("[data-value]")].map((el) => [
          el.dataset.value,
          el.type === "checkbox" ? el.checked : el.value.trim(),
        ]),
      );
      const result = await invoke("signatureflow-submit-signature", {
        token,
        requestId,
        expectedSha256: data.document.sha256,
        typedName,
        accepted: true,
        signatureDataUrl: pad.toDataURL("image/png"),
        initialsDataUrl: initialPad?.toDataURL("image/png"),
        values,
        readPages: [...viewedPages].sort((a, b) => a - b),
      });
      shell(
        `<main class="sign-page"><section class="card signed-result stack"><span class="result-check">✓</span><span class="eyebrow">${data.document.workflowType === "acknowledgement" ? "PRISE DE CONNAISSANCE ENREGISTRÉE" : "C’EST SIGNÉ"}</span><h1>Merci, ${esc(data.signer.name)}.</h1><p>Votre signature nominative a été enregistrée sur « ${esc(data.document.name)} ».</p>${result.delivery?.queued ? '<p class="success">Votre copie est en cours d’envoi automatique par e-mail.</p>' : ""}${result.delivery?.sent ? `<p class="success">${result.delivery.sent} copie(s) automatique(s) envoyée(s).</p>` : ""}${result.delivery?.failed ? `<p class="warning">La signature est valide, mais ${result.delivery.failed} envoi(s) automatique(s) ont échoué. L’organisateur devra transmettre la copie manuellement.</p>` : ""}${result.downloadUrl ? `<a class="btn primary" href="${esc(result.downloadUrl)}" target="_blank" rel="noopener noreferrer">Télécharger le PDF signé</a>` : ""}<button class="btn secondary" id="showSigned">Voir la dernière version</button><details><summary>Empreinte du document</summary><p class="hash">${esc(result.sha256)}</p></details><button class="btn secondary" id="exitSigning">Fermer</button></section></main>`,
      );
      $("#exitSigning").onclick = exitSigning;
      $("#showSigned").onclick = () => signingPage(token);
      await pdf.destroy();
    });
}
boot().catch((e) => notify(e.message, "error"));
