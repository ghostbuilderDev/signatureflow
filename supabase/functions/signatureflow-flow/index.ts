import * as lib from "npm:pdf-lib@1.17.1";
import {
  body,
  json,
  failure,
  corsHeaders,
  checked,
  HttpError,
  sha256Text,
  sha256Bytes,
  randomToken,
} from "../_shared/common.ts";
import {
  context,
  sitePermission,
  documentPermission,
  versionPermission,
  bundle,
  pdfBytes,
  originalMetadata,
  finishUpload,
  BUCKET,
} from "../_shared/flow-data.ts";
import {
  normalizeRecipients,
  batches,
  validUUID,
  buildEnvelope,
} from "../_shared/flow-core.mjs";
import {
  publicBase,
  decryptLink,
  encryptLink,
} from "../_shared/flow-security.ts";
import {
  runJobs,
  archiveVersion,
  scheduleReminders,
} from "../_shared/flow-jobs.ts";
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  try {
    const ctx = await context(req),
      input = await body(req, 1200000),
      action = input.action;
    if (action === "health")
      return json({
        ok: true,
        mail:
          !!Deno.env.get("RESEND_API_KEY") &&
          !!(
            Deno.env.get("SIGNATUREFLOW_EMAIL_FROM") ||
            Deno.env.get("JOURNAL_CR_FROM") ||
            Deno.env.get("EMAIL_FROM")
          ),
        linkEncryption: /^[a-f0-9]{64}$/i.test(
          Deno.env.get("SIGNATUREFLOW_FLOW_KEY") || "",
        ),
        scheduledWorker: !!Deno.env.get("SIGNATUREFLOW_JOB_TOKEN"),
        publicUrl: publicBase().href,
      });
    if (action === "list") {
      if (input.chantierId) await sitePermission(ctx, input.chantierId);
      let query = ctx.admin
        .from("sf3_documents")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      query = input.chantierId
        ? query.eq("chantier_id", input.chantierId)
        : query.eq("owner_id", ctx.user.id).is("chantier_id", null);
      const documents = checked(await query) || [];
      const ids = documents.map((d: any) => d.id);
      const versions = ids.length
        ? checked(
            await ctx.admin
              .from("sf3_versions")
              .select("*")
              .in("document_id", ids)
              .order("created_at", { ascending: false }),
          ) || []
        : [];
      const canManage = input.chantierId
        ? checked(
            await ctx.scoped.rpc("journal_can_manage_chantier_documents", {
              p_chantier_id: input.chantierId,
            }),
          )
        : true;
      return json({ documents, versions, canManage });
    }
    if (action === "members") {
      await sitePermission(ctx, input.chantierId, true);
      const rows =
        checked(
          await ctx.admin
            .from("chantier_members")
            .select("user_id,role")
            .eq("chantier_id", input.chantierId),
        ) || [];
      const profiles = rows.length
        ? checked(
            await ctx.admin
              .from("profiles")
              .select("id,email,full_name,company")
              .in(
                "id",
                rows.map((m: any) => m.user_id),
              ),
          ) || []
        : [];
      return json({
        members: profiles.map((p: any) => ({
          ...p,
          role: rows.find((m: any) => m.user_id === p.id)?.role,
        })),
      });
    }
    if (action === "inbox") {
      // A verified current Auth email, never user_metadata or a user-supplied identity.
      const email = String(ctx.user.email || "").toLowerCase();
      if (!email || !ctx.user.email_confirmed_at) return json({ items: [] });
      const signers =
        checked(
          await ctx.admin
            .from("signatureflow_signers")
            .select("id,document_id,name,email,role,status,token_expires_at")
            .eq("email", email)
            .in("status", ["pending", "signing"])
            .limit(300),
        ) || [];
      const rows = signers.length
        ? checked(
            await ctx.admin
              .from("sf3_recipients")
              .select("*")
              .in(
                "signer_id",
                signers.map((s: any) => s.id),
              ),
          ) || []
        : [];
      const items = [];
      for (const row of rows) {
        if (!row.link_cipher) continue;
        const campaign = checked(
          await ctx.admin
            .from("sf3_campaigns")
            .select("*")
            .eq("id", row.campaign_id)
            .single(),
        );
        const b = await bundle(ctx.admin, campaign.version_id);
        const signer = signers.find((s: any) => s.id === row.signer_id);
        const envelope = b.envelopes.find((e: any) => e.id === row.envelope_id);
        if (
          b.version.state !== "current" ||
          envelope?.status !== "in_progress" ||
          !signer ||
          new Date(signer.token_expires_at) < new Date()
        )
          continue;
        // A link can be used without JDC membership, but JDC never discloses information from a different assigned email.
        items.push({
          id: row.signer_id,
          title: b.doc.title,
          label: b.version.label,
          documentType: b.doc.document_type,
          chantierId: b.doc.chantier_id,
          role: signer.role,
          deadline: campaign.deadline,
          mode: campaign.mode,
          url: await decryptLink(row.link_cipher),
        });
      }
      return json({ items });
    }
    if (action === "prepareUpload" || action === "importJdc") {
      let source: any;
      if (action === "importJdc") {
        source = checked(
          await ctx.admin
            .from("chantier_documents")
            .select("*")
            .eq("id", input.sourceDocumentId)
            .single(),
        );
        await sitePermission(ctx, source.chantier_id, true);
        if (
          input.chantierId !== source.chantier_id ||
          input.folderId !== source.folder_id
        )
          throw new HttpError(
            "Le document doit rester dans son chantier et son dossier d’origine.",
          );
      }
      const { doc, version } = await originalMetadata(ctx, input);
      if (source) {
        const bytes = await pdfBytes(
          ctx.admin,
          "chantier-documents",
          source.storage_path,
        );
        checked(
          await ctx.admin.storage
            .from(BUCKET)
            .upload(version.source_path, bytes, {
              contentType: "application/pdf",
              upsert: false,
            }),
        );
        const ready = await finishUpload(ctx, version.id);
        return json({ doc, version: ready });
      }
      const upload = checked(
        await ctx.admin.storage
          .from(BUCKET)
          .createSignedUploadUrl(version.source_path, { upsert: false }),
      );
      return json({ doc, version, upload });
    }
    if (action === "finishUpload")
      return json({ version: await finishUpload(ctx, input.versionId) });
    if (action === "publishVersion") {
      const { version, doc } = await versionPermission(
        ctx,
        input.versionId,
        true,
      );
      if (
        input.expectedCurrentVersionId !== doc.current_version_id &&
        !(input.expectedCurrentVersionId === null && !doc.current_version_id)
      )
        throw new HttpError("La version courante a changé. Actualisez.", 409);
      checked(
        await ctx.admin.rpc("sf3_publish_version", {
          p_version: version.id,
          p_expected: doc.current_version_id || null,
          p_actor: ctx.user.id,
        }),
      );
      return json({ ok: true });
    }
    if (action === "details") {
      const { version, doc } = await versionPermission(ctx, input.versionId);
      const b = await bundle(ctx.admin, version.id);
      const canManage = doc.chantier_id
        ? checked(
            await ctx.scoped.rpc("journal_can_manage_chantier_documents", {
              p_chantier_id: doc.chantier_id,
            }),
          )
        : true;
      const sourceUrl = checked(
        await ctx.admin.storage
          .from(BUCKET)
          .createSignedUrl(version.source_path, 900),
      )?.signedUrl;
      const archives = await Promise.all(
        b.archives.map(async (a: any) => ({
          ...a,
          url: checked(
            await ctx.admin.storage
              .from(a.storage_bucket)
              .createSignedUrl(a.storage_path, 900),
          )?.signedUrl,
        })),
      );
      const events =
        checked(
          await ctx.admin
            .from("sf3_events")
            .select("*")
            .eq("version_id", version.id)
            .order("created_at", { ascending: false })
            .limit(300),
        ) || [];
      const jobs = canManage
        ? checked(
            await ctx.admin
              .from("sf3_jobs")
              .select(
                "id,kind,status,attempts,last_error,resend_id,delivered_at,payload",
              )
              .eq("version_id", version.id)
              .order("created_at", { ascending: false })
              .limit(300),
          ) || []
        : [];
      return json({
        ...b,
        envelopes: await Promise.all(
          b.envelopes.map(async ({ lock_id, lock_until, ...e }: any) => ({
            ...e,
            previewUrl: canManage
              ? checked(
                  await ctx.admin.storage
                    .from(BUCKET)
                    .createSignedUrl(e.current_storage_path, 900),
                )?.signedUrl
              : null,
          })),
        ),
        archives,
        events,
        jobs: jobs.map(({ payload, ...j }: any) => ({
          ...j,
          emailState: payload?.email_state || null,
        })),
        sourceUrl,
        canManage,
        legacyUrl: publicBase().href,
        currentUserId: ctx.user.id,
      });
    }
    if (action === "createCampaign") {
      const { version, doc } = await versionPermission(
        ctx,
        input.versionId,
        true,
      );
      if (version.state !== "current" || doc.current_version_id !== version.id)
        throw new HttpError("Publiez la version avant de la diffuser.");
      if (!["application", "acknowledgement"].includes(input.mode))
        throw new HttpError("Circuit invalide");
      if (input.reviewed !== true)
        throw new HttpError(
          "Confirmez le contrôle du document et des destinataires.",
        );
      if (!/^[a-f0-9]{64}$/i.test(Deno.env.get("SIGNATUREFLOW_FLOW_KEY") || ""))
        throw new HttpError(
          "Configurez SIGNATUREFLOW_FLOW_KEY avant la diffusion.",
          503,
        );
      const normalized = normalizeRecipients(input.recipients);
      if (input.mode === "application" && normalized.length > 40)
        throw new HttpError(
          "40 signatures d’application maximum par campagne. Vous pouvez lancer une campagne suivante après clôture.",
        );
      if (
        doc.document_type === "CSF" &&
        input.mode === "application" &&
        normalized.length !== 1
      )
        throw new HttpError(
          "La signature d’application de la CSF est celle de son rédacteur. Les autres interlocuteurs signent une prise de connaissance en annexe.",
        );
      const copies = Array.isArray(input.copies)
        ? [
            ...new Set(
              input.copies
                .map((x: any) => String(x).trim().toLowerCase())
                .filter(Boolean),
            ),
          ]
        : [];
      if (
        copies.length > 100 ||
        copies.some((x: any) => !/^\S+@\S+\.\S+$/.test(x))
      )
        throw new HttpError("Adresses de copie invalides");
      const campaignId = validUUID(input.requestId)
        ? input.requestId
        : crypto.randomUUID();
      const existing = checked(
        await ctx.admin
          .from("sf3_campaigns")
          .select("id,version_id")
          .eq("id", campaignId)
          .maybeSingle(),
      );
      if (existing) {
        if (existing.version_id !== version.id)
          throw new HttpError("Identifiant déjà utilisé");
        return json({ ok: true, campaignId, alreadyPrepared: true });
      }
      if (
        input.deadline &&
        (!Number.isFinite(Date.parse(input.deadline)) ||
          Date.parse(input.deadline) <= Date.now())
      )
        throw new HttpError("L’échéance doit être dans le futur.");
      const b = await bundle(ctx.admin, version.id);
      if (b.linkedCSFStale)
        throw new HttpError(
          "La CSF liée a changé. Vérifiez l’ISF et publiez un nouvel indice avant une nouvelle diffusion.",
        );
      const appEnvelopes = b.mappings
        .filter(
          (m: any) =>
            b.campaigns.find((c: any) => c.id === m.campaign_id)?.mode ===
            "application",
        )
        .map((m: any) => b.envelopes.find((e: any) => e.id === m.envelope_id))
        .filter(Boolean);
      const application = appEnvelopes
        .filter((e: any) => e.status === "signed")
        .at(-1);
      const source = await pdfBytes(
        ctx.admin,
        BUCKET,
        application?.current_storage_path || version.source_path,
      );
      const envelopes = [];
      for (const group of batches(normalized)) {
        const envelopeId = crypto.randomUUID();
        const signers = await Promise.all(
          group.map(async (r: any, i: number) => {
            const profile = checked(
              await ctx.admin
                .from("profiles")
                .select("id")
                .eq("email", r.email)
                .maybeSingle(),
            );
            return {
              ...r,
              id: crypto.randomUUID(),
              order: i + 1,
              user_id: profile?.id || null,
              role: r.company
                ? `${r.role} - ${r.company}`.slice(0, 260)
                : r.role,
            };
          }),
        );
        const generated = await buildEnvelope(
          source,
          signers,
          {
            mode: input.mode,
            title: doc.title,
            label: version.label,
            sha256: version.source_sha256,
            campaignId,
          },
          lib,
        );
        if (generated.bytes.length > 20 * 1024 * 1024)
          throw new HttpError(
            "Le PDF et ses annexes dépassent 20 Mo. Réduisez la taille du document.",
          );
        const path = `${ctx.user.id}/${envelopeId}/original.pdf`;
        checked(
          await ctx.admin.storage.from(BUCKET).upload(path, generated.bytes, {
            contentType: "application/pdf",
            upsert: false,
          }),
        );
        envelopes.push({
          id: envelopeId,
          path,
          sha256: await sha256Bytes(generated.bytes),
          pages: generated.pages,
          annex_start: generated.annexStart,
          fields: generated.fields,
          signers,
          name: `${doc.title} - indice ${version.label} - ${input.mode === "application" ? "application" : "prise de connaissance"}`.slice(
            0,
            200,
          ),
        });
      }
      checked(
        await ctx.admin.rpc("sf3_register_campaign", {
          p_campaign: {
            id: campaignId,
            version_id: version.id,
            owner_id: ctx.user.id,
            mode: input.mode,
            deadline: input.deadline || null,
            copies,
            reminder_hours: Number(input.reminderHours) || 48,
            require_full_read: input.requireFullRead !== false,
          },
          p_envelopes: envelopes,
        }),
      );
      return json({
        ok: true,
        campaignId,
        envelopes: envelopes.map((e: any) => ({
          id: e.id,
          url: new URL(`?document=${e.id}`, publicBase()).href,
        })),
        next: "Ouvrez chaque dossier, contrôlez les emplacements, puis validez pour créer les liens.",
      });
    }
    if (action === "issueAcknowledgement") {
      const env = checked(
        await ctx.admin
          .from("signatureflow_documents")
          .select("*")
          .eq("id", input.envelopeId)
          .single(),
      );
      const mapping = checked(
        await ctx.admin
          .from("sf3_envelopes")
          .select("*")
          .eq("envelope_id", env.id)
          .single(),
      );
      const campaign = checked(
        await ctx.admin
          .from("sf3_campaigns")
          .select("*")
          .eq("id", mapping.campaign_id)
          .single(),
      );
      const { version, doc } = await versionPermission(
        ctx,
        campaign.version_id,
        true,
      );
      if ((await bundle(ctx.admin, version.id)).linkedCSFStale)
        throw new HttpError(
          "La CSF liée a changé. Vérifiez l’ISF avant une nouvelle diffusion.",
        );
      if (
        campaign.mode !== "acknowledgement" ||
        version.state !== "current" ||
        doc.current_version_id !== version.id ||
        input.reviewed !== true
      )
        throw new HttpError("Contrôle du circuit et de l’indice requis.");
      if (!["draft", "in_progress"].includes(env.status))
        throw new HttpError("Cette collecte est terminée ou annulée.");
      const signers =
        checked(
          await ctx.admin
            .from("signatureflow_signers")
            .select("*")
            .eq("document_id", env.id),
        ) || [];
      const fields =
        checked(
          await ctx.admin
            .from("signatureflow_signature_fields")
            .select("*")
            .eq("document_id", env.id),
        ) || [];
      if (
        signers.some(
          (s: any) =>
            !fields.some(
              (f: any) =>
                f.signer_id === s.id &&
                f.page > mapping.annex_start &&
                f.kind === "signature",
            ),
        )
      )
        throw new HttpError(
          "Une zone d’annexe manque. Contrôlez les emplacements.",
        );
      const bytes = await pdfBytes(ctx.admin, BUCKET, env.current_storage_path),
        pdf = await lib.PDFDocument.load(bytes);
      const expires = new Date(
        Math.min(
          Date.now() + 14 * 86400000,
          campaign.deadline ? new Date(campaign.deadline).getTime() : Infinity,
        ),
      ).toISOString();
      if (new Date(expires).getTime() <= Date.now())
        throw new HttpError(
          "L’échéance est dépassée. Préparez une nouvelle campagne.",
        );
      const links = await Promise.all(
        signers
          .filter((s: any) => s.status !== "signed")
          .map(async (s: any) => {
            const token = randomToken(),
              url = publicBase();
            url.hash = "sign=" + token;
            return {
              id: s.id,
              hash: await sha256Text(token),
              expires,
              cipher: await encryptLink(url.href),
            };
          }),
      );
      if (env.status === "draft")
        checked(
          await ctx.admin
            .from("signatureflow_documents")
            .update({ prepared_at: new Date().toISOString() })
            .eq("id", env.id)
            .eq("status", "draft"),
        );
      checked(
        await ctx.admin.rpc("sf3_issue", {
          p_document: env.id,
          p_owner: env.owner_id,
          p_links: links.map(({ cipher, ...l }: any) => l),
          p_encrypted: links,
          p_hash: await sha256Bytes(bytes),
          p_pages: pdf.getPageCount(),
          p_manifest: fields.map(
            ({
              id,
              signer_id,
              page,
              x,
              y,
              width,
              height,
              kind,
              required,
            }: any) => ({
              id,
              signer_id,
              page,
              x,
              y,
              width,
              height,
              kind,
              required,
            }),
          ),
        }),
      );
      return json({ ok: true, queued: links.length });
    }
    if (action === "sync") {
      await versionPermission(ctx, input.versionId, true);
      if (input.retry === true)
        checked(
          await ctx.admin
            .from("sf3_jobs")
            .update({
              status: "pending",
              attempts: 0,
              available_at: new Date().toISOString(),
            })
            .eq("version_id", input.versionId)
            .eq("status", "error"),
        );
      await scheduleReminders(ctx.admin, input.versionId);
      return json({ results: await runJobs(ctx.admin, input.versionId, 8) });
    }
    if (action === "archive") {
      await versionPermission(ctx, input.versionId, true);
      return json({
        archive: await archiveVersion(ctx.admin, input.versionId),
      });
    }
    if (action === "cancelCampaign") {
      const campaign = checked(
        await ctx.admin
          .from("sf3_campaigns")
          .select("*")
          .eq("id", input.campaignId)
          .single(),
      );
      await versionPermission(ctx, campaign.version_id, true);
      const b = await bundle(ctx.admin, campaign.version_id);
      for (const m of b.mappings.filter(
        (m: any) => m.campaign_id === campaign.id,
      )) {
        const env = b.envelopes.find((e: any) => e.id === m.envelope_id);
        if (env && ["draft", "in_progress"].includes(env.status))
          checked(
            await ctx.admin.rpc("signatureflow_cancel", {
              p_document: env.id,
              p_owner: env.owner_id,
            }),
          );
      }
      checked(
        await ctx.admin.from("sf3_jobs").upsert(
          {
            job_key: "cancel:" + campaign.id,
            kind: "archive",
            version_id: campaign.version_id,
          },
          { onConflict: "job_key", ignoreDuplicates: true },
        ),
      );
      checked(
        await ctx.admin.from("sf3_events").insert({
          version_id: campaign.version_id,
          actor_id: ctx.user.id,
          event_type: "campaign_cancelled",
          metadata: { campaign_id: campaign.id },
        }),
      );
      return json({ ok: true });
    }
    throw new HttpError("Action inconnue");
  } catch (e) {
    return failure(e);
  }
});
