(function (root) {
  "use strict";
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const date = (v) => (v ? new Date(v).toLocaleString("fr-FR") : "—");
  const types = {
    CSF: "CSF",
    ISF: "ISF",
    PPSPS: "PPSPS",
    PARTICULARITES: "Particularités locales",
    AUTRE: "Autre document",
  };
  const states = {
    uploading: "Import à terminer",
    draft: "À publier",
    current: "Version courante",
    superseded: "Ancienne version",
    pending: "En attente",
    signing: "Enregistrement",
    signed: "Signé",
    cancelled: "Annulé",
  };
  const emailStates = {
    pending: "À envoyer",
    accepted: "Accepté par Resend",
    delivered: "Remis au serveur destinataire",
    bounced: "Adresse en échec",
    failed: "Échec de remise",
    complained: "Signalé comme indésirable",
  };
  function options(rows, value) {
    return rows
      .map(
        (r) =>
          `<option value="${esc(r.value)}" ${r.value === value ? "selected" : ""}>${esc(r.label)}</option>`,
      )
      .join("");
  }
  function create(config) {
    const state = () => config.getState?.() || {},
      client = () => config.getClient?.();
    let host = null,
      selection = null,
      generation = 0,
      listCache = null,
      detailCache = null;
    async function api(action, values = {}) {
      const db = client();
      if (!db)
        throw new Error("Connexion à votre espace organisateur requise.");
      const actor = state().user?.id,
        { data, error } = await db.auth.getSession();
      if (error) throw error;
      const token = data.session?.access_token;
      if (!token) throw new Error("Votre session a expiré. Reconnectez-vous.");
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch(
          `${config.supabaseUrl.replace(/\/$/, "")}/functions/v1/signatureflow-flow`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              apikey: config.publicKey || "",
            },
            body: JSON.stringify({ action, ...values }),
            signal: controller.signal,
          },
        );
        const result = await response.json();
        if (actor !== state().user?.id)
          throw new Error("Le compte connecté a changé. Rouvrez le module.");
        if (!response.ok || result.error)
          throw new Error(result.error || `Erreur ${response.status}`);
        return result;
      } finally {
        clearTimeout(timer);
      }
    }
    function notice(text, error = false) {
      const n = host?.querySelector("[data-notice]");
      if (n) {
        n.textContent = text;
        n.className = error ? "sf3-notice sf3-error" : "sf3-notice";
        n.hidden = false;
      }
    }
    async function busy(button, fn) {
      if (button?.disabled) return;
      const old = button?.textContent;
      if (button) {
        button.disabled = true;
        button.textContent = "Traitement…";
      }
      try {
        return await fn();
      } catch (e) {
        notice(
          e.name === "AbortError"
            ? "Le serveur tarde à répondre. Actualisez le suivi avant de recommencer."
            : e.message,
          true,
        );
      } finally {
        if (button?.isConnected) {
          button.disabled = false;
          button.textContent = old;
        }
      }
    }
    function shell(content) {
      if (!host) return;
      host.innerHTML = `<div class="sf3-heading"><div><span class="sf3-eyebrow">SIGNATUREFLOW · DOCUMENTS DU CHANTIER</span><h2>${esc(state().siteName || "Mon espace documentaire")}</h2></div><button type="button" data-close aria-label="Fermer">Fermer</button></div><p data-notice class="sf3-notice" role="status" hidden></p><div class="sf3-body">${content}</div>`;
      host.querySelector("[data-close]").onclick = () => {
        if (config.onClose) config.onClose();
        else host.innerHTML = "";
      };
    }
    function link(url, label) {
      let u;
      try {
        u = new URL(url, location.href);
        if (!["http:", "https:"].includes(u.protocol)) throw 0;
      } catch {
        return "";
      }
      return `<a class="sf3-button" target="_blank" rel="noopener noreferrer" href="${esc(u.href)}">${esc(label)}</a>`;
    }
    async function home() {
      const epoch = ++generation;
      const data = await api("list", {
        chantierId: state().chantierId || null,
      });
      if (epoch !== generation || !host?.isConnected) return;
      listCache = data;
      detailCache = null;
      shell(
        `<div class="sf3-actions"><button data-inbox>Mes demandes à traiter</button>${data.canManage ? '<button class="sf3-primary" data-new>Nouveau document / importer depuis JDC</button>' : ""}<button data-reload>Actualiser</button></div><div class="sf3-document-list">${
          data.documents
            .map((d) => {
              const versions = data.versions.filter(
                (v) => v.document_id === d.id,
              );
              const current = versions.find(
                (v) => v.id === d.current_version_id,
              );
              return `<article class="sf3-card"><span class="sf3-tag">${esc(types[d.document_type])}</span><h3>${esc(d.title)}</h3><p>${current ? `Indice ${esc(current.label)} · ${esc(states[current.state])} · application ${esc(date(current.effective_at))}` : "Aucune version publiée"}</p><div class="sf3-actions">${versions.map((v) => `<button data-version="${v.id}">Indice ${esc(v.label)} · ${esc(states[v.state])}</button>`).join("")}${data.canManage ? `<button data-new-version="${d.id}">Nouvel indice</button>` : ""}</div></article>`;
            })
            .join("") ||
          "<p>Aucun document suivi. Les fichiers déjà présents dans JDC restent disponibles dans leur dossier.</p>"
        }</div>`,
      );
      host
        .querySelector("[data-new]")
        ?.addEventListener("click", () => newVersion());
      host.querySelector("[data-reload]").onclick = (e) => busy(e.target, home);
      host.querySelector("[data-inbox]").onclick = (e) => busy(e.target, inbox);
      host
        .querySelectorAll("[data-version]")
        .forEach(
          (b) => (b.onclick = () => busy(b, () => details(b.dataset.version))),
        );
      host
        .querySelectorAll("[data-new-version]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              newVersion(
                data.documents.find((d) => d.id === b.dataset.newVersion),
              )),
        );
    }
    async function newVersion(doc = null, source = null) {
      const st = state(),
        files = (st.documents || []).filter(
          (d) =>
            d.mime_type === "application/pdf" || /\.pdf$/i.test(d.file_name),
        ),
        folders = st.folders || [];
      const candidate = source ? files.find((d) => d.id === source) : null;
      const title =
        doc?.title || candidate?.file_name?.replace(/\.pdf$/i, "") || "";
      const detected =
        Object.keys(types).find(
          (t) => t !== "AUTRE" && new RegExp(`\\b${t}\\b`, "i").test(title),
        ) || "AUTRE";
      shell(
        `<button data-back>Retour aux documents</button><form class="sf3-form" data-version-form><h3>${doc ? "Ajouter un nouvel indice" : "Enregistrer un document"}</h3>${
          doc
            ? ""
            : `<label>Titre<input name="title" value="${esc(title)}" required maxlength="200"></label><label>Type<select name="documentType">${options(
                Object.entries(types).map(([value, label]) => ({
                  value,
                  label,
                })),
                detected,
              )}</select></label>`
        }<label>Indice<input name="label" required maxlength="60" placeholder="Ex. B, 02…"></label><label>Application prévue<input name="effectiveAt" type="datetime-local"></label><label>Modifications apportées<textarea name="changeSummary" maxlength="2000" rows="3"></textarea></label>${
          st.chantierId
            ? `<label>Dossier de classement<select name="folderId" required>${options(
                folders.map((f) => ({ value: f.id, label: f.name })),
                doc?.folder_id || candidate?.folder_id || st.folderId,
              )}</select></label><label>PDF déjà dans JDC<select name="sourceDocumentId"><option value="">Importer un autre PDF</option>${options(
                files.map((d) => ({ value: d.id, label: d.file_name })),
                candidate?.id,
              )}</select></label>`
            : ""
        }<label>Fichier PDF<input name="file" type="file" accept="application/pdf,.pdf"></label><label>CSF associée<select name="linkedCSFVersionId"><option value="">Aucune</option>${options(
          (listCache?.versions || [])
            .filter(
              (v) =>
                v.state === "current" &&
                listCache.documents.find((d) => d.id === v.document_id)
                  ?.document_type === "CSF",
            )
            .map((v) => ({
              value: v.id,
              label: `${listCache.documents.find((d) => d.id === v.document_id).title} · ${v.label}`,
            })),
          null,
        )}</select></label><p>Le fichier original sera conservé. La publication de cet indice et sa diffusion seront confirmées séparément.</p><button class="sf3-primary" type="submit">Enregistrer cet indice</button></form>`,
      );
      host.querySelector("[data-back]").onclick = () => busy(null, home);
      const form = host.querySelector("form");
      form.onsubmit = (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          const f = new FormData(form),
            file = form.elements.file.files[0],
            sourceId = f.get("sourceDocumentId") || null;
          let folderId = doc?.folder_id || f.get("folderId") || null;
          if (!sourceId && !file)
            throw new Error("Choisissez le PDF à intégrer.");
          if (file && file.size > 20 * 1024 * 1024)
            throw new Error("Le PDF dépasse 20 Mo.");
          if (sourceId) {
            const existing = files.find((d) => d.id === sourceId);
            folderId = existing.folder_id;
            if (doc && folderId !== doc.folder_id)
              throw new Error(
                "La nouvelle version doit rester dans le même dossier documentaire.",
              );
          }
          const payload = {
            documentId: doc?.id,
            title: doc?.title || f.get("title"),
            documentType: doc?.document_type || f.get("documentType"),
            label: f.get("label"),
            effectiveAt: f.get("effectiveAt")
              ? new Date(f.get("effectiveAt")).toISOString()
              : null,
            changeSummary: f.get("changeSummary"),
            chantierId: st.chantierId || null,
            folderId,
            sourceDocumentId: sourceId,
            linkedCSFVersionId: f.get("linkedCSFVersionId") || null,
          };
          const result = await api(
            sourceId ? "importJdc" : "prepareUpload",
            payload,
          );
          if (!sourceId) {
            const response = await fetch(result.upload.signedUrl, {
              method: "PUT",
              headers: { "Content-Type": "application/pdf" },
              body: file,
            });
            if (!response.ok)
              throw new Error(
                "Envoi du PDF interrompu. Le document n’a pas été publié.",
              );
            await api("finishUpload", { versionId: result.version.id });
          }
          await details(result.version.id);
        });
      };
    }
    async function details(id) {
      const epoch = ++generation;
      const data = await api("details", { versionId: id });
      if (epoch !== generation || !host?.isConnected) return;
      detailCache = data;
      selection = id;
      const counted = data.signers.filter(
        (s) =>
          data.envelopes.find((e) => e.id === s.document_id)?.status !==
          "cancelled",
      );
      const signed = counted.filter((s) => s.status === "signed").length;
      shell(`<button data-back>Retour aux documents</button><article class="sf3-card"><span class="sf3-tag">${esc(types[data.doc.document_type])} · ${esc(states[data.version.state])}</span><h3>${esc(data.doc.title)} — indice ${esc(data.version.label)}</h3>${data.linkedCSFStale ? '<p class="sf3-error">La CSF associée a évolué. Vérifiez cette ISF et publiez un nouvel indice avant une nouvelle diffusion.</p>' : ""}<p>${esc(data.version.change_summary || "Aucun motif de modification renseigné.")}</p><p>Application : ${esc(date(data.version.effective_at))}</p><details><summary>Intégrité de l’original</summary><code>${esc(data.version.source_sha256 || "Import à terminer")}</code></details><div class="sf3-actions">${data.sourceUrl ? link(data.sourceUrl, "Consulter l’original") : ""}${data.canManage && data.version.state === "draft" ? '<button class="sf3-primary" data-publish>Publier cet indice</button>' : ""}${data.canManage && data.version.state === "current" ? '<button class="sf3-primary" data-campaign>Préparer une diffusion</button>' : ""}<button data-refresh>Actualiser le suivi</button></div></article>
  <div class="sf3-metrics"><strong>${signed} / ${counted.length}</strong><span>signatures enregistrées · les demandes non terminées restent visibles</span></div>
  ${data.canManage ? '<div class="sf3-actions"><button data-sync>Traiter les mails et classements en attente</button><button data-retry>Réessayer les traitements en erreur</button><button data-archive>Créer un état documentaire</button></div>' : ""}
  ${data.campaigns
    .map(
      (c) =>
        `<section class="sf3-card"><h3>${c.mode === "application" ? "Signatures d’application" : "Prises de connaissance en annexe"}</h3><p>Échéance : ${esc(date(c.deadline))}</p>${data.mappings
          .filter((m) => m.campaign_id === c.id)
          .map((m) => {
            const env = data.envelopes.find((e) => e.id === m.envelope_id);
            return `<div class="sf3-actions"><span>${esc(states[env?.status])}</span>${env?.previewUrl ? link(env.previewUrl, "Contrôler le PDF et son annexe") : ""}${data.canManage && c.mode === "acknowledgement" && ["draft", "in_progress"].includes(env?.status) ? `<button class="sf3-primary" data-issue="${m.envelope_id}">${env.status === "draft" ? "Valider et envoyer les invitations" : "Renouveler les invitations"}</button>` : ""}${data.canManage && env?.owner_id === data.currentUserId && ["draft", "in_progress"].includes(env?.status) ? link(new URL(`?document=${m.envelope_id}`, data.legacyUrl).href, env.status === "draft" ? "Contrôler et créer les liens" : "Renouveler les liens") : ""}</div>`;
          })
          .join(
            "",
          )}<div class="sf3-table-wrap"><table><thead><tr><th>Personne / fonction</th><th>Entreprise</th><th>Mail</th><th>Consultation</th><th>Signature</th></tr></thead><tbody>${data.recipients
          .filter((r) => r.campaign_id === c.id)
          .map((r) => {
            const s = data.signers.find((s) => s.id === r.signer_id);
            return `<tr><td><b>${esc(s?.name)}</b><br>${esc(s?.role)}<br>${esc(s?.email)}</td><td>${esc(r.company)}</td><td>${esc(emailStates[r.email_status] || r.email_status)}</td><td>${esc(date(r.opened_at))}</td><td>${esc(states[s?.status] || s?.status)}<br>${esc(date(s?.signed_at))}</td></tr>`;
          })
          .join(
            "",
          )}</tbody></table></div>${data.canManage && data.envelopes.some((e) => data.mappings.some((m) => m.envelope_id === e.id && m.campaign_id === c.id) && ["draft", "in_progress"].includes(e.status)) ? `<button data-cancel="${c.id}">Annuler les demandes restantes de cette campagne</button>` : ""}</section>`,
    )
    .join("")}
  <section class="sf3-card"><h3>Documents classés et états précédents</h3>${data.archives.map((a) => `<p>${link(a.url, `${a.complete ? "Collecte complète" : "État intermédiaire"} · ${a.signed_count}/${a.expected_count} · ${date(a.created_at)}`)}</p>`).join("") || "<p>Le PDF et son annexe seront classés après l’enregistrement des signatures.</p>"}</section>
  ${
    data.canManage
      ? `<section class="sf3-card"><h3>Traitements automatiques</h3>${
          data.jobs
            .filter((j) => j.status === "error")
            .map(
              (j) =>
                `<p class="sf3-error">${esc(j.kind)} : ${esc(j.last_error)}</p>`,
            )
            .join("") || "<p>Aucune erreur signalée.</p>"
        }<p>${data.jobs.filter((j) => j.status === "pending" || j.status === "running").length} traitement(s) en attente.</p><button data-export>Exporter la traçabilité</button></section>`
      : ""
  }`);
      host.querySelector("[data-back]").onclick = () => busy(null, home);
      host.querySelector("[data-refresh]").onclick = (e) =>
        busy(e.target, () => details(id));
      host.querySelector("[data-publish]")?.addEventListener("click", (e) =>
        busy(e.target, async () => {
          if (
            !confirm(
              `Publier l’indice ${data.version.label} ? Les demandes non signées sur l’ancien indice seront désactivées ; les preuves déjà enregistrées seront conservées.`,
            )
          )
            return;
          await api("publishVersion", {
            versionId: id,
            expectedCurrentVersionId: data.doc.current_version_id || null,
          });
          await details(id);
        }),
      );
      host
        .querySelector("[data-campaign]")
        ?.addEventListener("click", () => busy(null, () => campaign(data)));
      for (const [selector, action, extra] of [
        ["[data-sync]", "sync", {}],
        ["[data-retry]", "sync", { retry: true }],
        ["[data-archive]", "archive", {}],
      ])
        host.querySelector(selector)?.addEventListener("click", (e) =>
          busy(e.target, async () => {
            const r = await api(action, { versionId: id, ...extra });
            await details(id);
            if (r.results?.some((j) => !j.ok))
              notice(
                "Certains traitements restent en erreur. Le détail est affiché dans le suivi.",
                true,
              );
            config.onRefresh?.();
          }),
        );
      host.querySelectorAll("[data-issue]").forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, async () => {
              if (
                !confirm(
                  "Confirmez le contrôle du PDF original, de l’indice, des destinataires et des emplacements en annexe. Les invitations seront mises en envoi automatique.",
                )
              )
                return;
              await api("issueAcknowledgement", {
                envelopeId: b.dataset.issue,
                reviewed: true,
              });
              await details(id);
              notice(
                "Invitations enregistrées. Les mails seront envoyés par le traitement automatique.",
              );
            })),
      );
      host.querySelectorAll("[data-cancel]").forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, async () => {
              if (
                !confirm(
                  "Annuler les demandes non terminées de cette campagne ? Les preuves et archives déjà enregistrées resteront conservées.",
                )
              )
                return;
              await api("cancelCampaign", { campaignId: b.dataset.cancel });
              await details(id);
            })),
      );
      host.querySelector("[data-export]")?.addEventListener("click", () => {
        const clean = {
          document: data.doc,
          version: data.version,
          campaigns: data.campaigns,
          signers: data.signers.map(({ token_expires_at, ...s }) => s),
          recipients: data.recipients,
          archives: data.archives.map(({ url, ...a }) => a),
          events: data.events,
        };
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(clean, null, 2)], {
            type: "application/json",
          }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `tracabilite-${data.version.label}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      });
    }
    async function campaign(data) {
      let members = [];
      if (data.doc.chantier_id)
        members = (await api("members", { chantierId: data.doc.chantier_id }))
          .members;
      const applicationFirst =
        ["CSF", "ISF", "PPSPS"].includes(data.doc.document_type) &&
        !data.campaigns.some((c) => c.mode === "application");
      shell(
        `<button data-back>Retour au suivi</button><form class="sf3-form" data-campaign-form><h3>Diffuser ${esc(data.doc.title)} — indice ${esc(data.version.label)}</h3><label>Action attendue<select name="mode"><option value="acknowledgement" ${applicationFirst ? "" : "selected"}>Prise de connaissance avec signature en annexe</option><option value="application" ${applicationFirst ? "selected" : ""}>Signature d’application dans le document</option></select></label><p>${data.doc.document_type === "CSF" ? "CSF : le rédacteur signe le document ; les interlocuteurs attestent ensuite leur prise de connaissance en annexe. " : data.doc.document_type === "ISF" ? "ISF : recueillez les signatures d’application des entreprises, puis les prises de connaissance des intervenants. " : ""}Les destinataires extérieurs signent par lien personnel, sans compte JDC. Pour une prise de connaissance, les emplacements en annexe sont préparés automatiquement.</p>${
          members.length
            ? `<label>Ajouter un membre du chantier<select data-members><option value="">Choisir une personne…</option>${options(
                members.map((m) => ({
                  value: m.id,
                  label: `${m.full_name || m.email} · ${m.company || ""}`,
                })),
                null,
              )}</select></label>`
            : ""
        }<div data-recipients class="sf3-recipients"></div><button type="button" data-add>Ajouter un interlocuteur extérieur</button><details><summary>Ajouter une liste de destinataires</summary><label>Une personne par ligne : nom ; e-mail ; fonction ; entreprise<textarea data-csv rows="4"></textarea></label><button type="button" data-import>Ajouter la liste</button></details><label>Échéance<input name="deadline" type="datetime-local"></label><label>Relance après<select name="reminderHours"><option value="24">24 heures</option><option value="48" selected>48 heures</option><option value="72">72 heures</option><option value="168">7 jours</option></select></label><label>Copies du dossier complet<textarea name="copies" rows="2" placeholder="Adresses séparées par une virgule"></textarea></label><label class="sf3-check"><input name="requireFullRead" type="checkbox" checked>Demander la consultation de toutes les pages avant de signer</label><label class="sf3-check"><input name="reviewed" type="checkbox" required>J’ai contrôlé le document, son indice, les destinataires et l’action attendue</label><button class="sf3-primary" type="submit">Préparer les dossiers de signature</button></form>`,
      );
      host.querySelector("[data-back]").onclick = () =>
        busy(null, () => details(data.version.id));
      const add = (m = {}) => {
        if (m.email)
          host.querySelectorAll(".sf3-recipient").forEach((r) => {
            if ([...r.querySelectorAll("input")].every((i) => !i.value))
              r.remove();
          });
        const row = document.createElement("fieldset");
        row.className = "sf3-recipient";
        row.innerHTML = `<legend>Destinataire</legend><label>Nom<input data-name required value="${esc(m.full_name || m.name || "")}" maxlength="160"></label><label>E-mail<input data-email required type="email" value="${esc(m.email || "")}" maxlength="254"></label><label>Fonction sur ce document<input data-role required value="${esc(m.role || "")}" maxlength="100" placeholder="Ex. RSO, responsable de chantier…"></label><label>Entreprise<input data-company value="${esc(m.company || "")}" maxlength="160"></label><button type="button" data-remove>Retirer</button>`;
        row.querySelector("[data-remove]").onclick = () => row.remove();
        host.querySelector("[data-recipients]").append(row);
      };
      add();
      host.querySelector("[data-add]").onclick = () => add();
      host.querySelector("[data-members]")?.addEventListener("change", (e) => {
        const m = members.find((m) => m.id === e.target.value);
        if (m) add({ ...m, role: "" });
        e.target.value = "";
      });
      host.querySelector("[data-import]").onclick = () => {
        host
          .querySelector("[data-csv]")
          .value.split(/\r?\n/)
          .filter((l) => l.trim())
          .forEach((line) => {
            const [name, email, role, company] = line
              .split(";")
              .map((x) => x.trim());
            add({ name, email, role, company });
          });
        host.querySelector("[data-csv]").value = "";
      };
      const form = host.querySelector("form"),
        requestId = crypto.randomUUID();
      form.onsubmit = (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          const f = new FormData(form);
          const recipients = [...form.querySelectorAll(".sf3-recipient")].map(
            (r) => ({
              name: r.querySelector("[data-name]").value,
              email: r.querySelector("[data-email]").value,
              role: r.querySelector("[data-role]").value,
              company: r.querySelector("[data-company]").value,
            }),
          );
          const result = await api("createCampaign", {
            versionId: data.version.id,
            requestId,
            recipients,
            mode: f.get("mode"),
            copies: String(f.get("copies") || "")
              .split(/[;,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
            deadline: f.get("deadline")
              ? new Date(f.get("deadline")).toISOString()
              : null,
            reminderHours: Number(f.get("reminderHours")),
            requireFullRead: form.elements.requireFullRead.checked,
            reviewed: form.elements.reviewed.checked,
          });
          await details(data.version.id);
          notice(
            result.next ||
              "Dossiers préparés. Ouvrez le contrôle des emplacements pour créer les liens.",
          );
        });
      };
    }
    async function inbox() {
      const result = await api("inbox");
      shell(
        `<button data-back>Retour aux documents</button><h3>Mes documents à consulter et signer</h3>${result.items.map((i) => `<article class="sf3-card"><h3>${esc(i.title)} — indice ${esc(i.label)}</h3><p>${esc(i.mode === "application" ? "Signature d’application" : "Prise de connaissance")} · ${esc(i.role)}</p><p>Échéance : ${esc(date(i.deadline))}</p>${link(i.url, "Consulter et signer")}</article>`).join("") || "<p>Aucune demande en attente pour votre adresse de connexion.</p>"}`,
      );
      host.querySelector("[data-back]").onclick = () => busy(null, home);
    }
    return {
      api,
      async mount(element, opts = {}) {
        host = element;
        host.classList.add("sf3-root");
        host.innerHTML =
          '<p role="status">Chargement de votre espace documentaire…</p>';
        try {
          if (opts.sourceDocumentId) {
            const r = await api("list", {
              chantierId: state().chantierId || null,
            });
            listCache = r;
            const known = r.versions.find(
              (v) => v.source_document_id === opts.sourceDocumentId,
            );
            if (known) await details(known.id);
            else await newVersion(null, opts.sourceDocumentId);
          } else if (opts.inbox) await inbox();
          else await home();
        } catch (e) {
          shell("<button data-retry>Réessayer</button>");
          notice(e.message, true);
          host.querySelector("[data-retry]").onclick = () => busy(null, home);
        }
      },
      destroy() {
        generation++;
        host = null;
      },
      reload: home,
    };
  }
  root.SignatureFlowDocumentUI = { create };
})(typeof window !== "undefined" ? window : globalThis);
