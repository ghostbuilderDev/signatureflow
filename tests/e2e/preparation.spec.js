import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const owner = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const signerId = "33333333-3333-4333-8333-333333333333";

async function openDraft(page, { failIssue = false } = {}) {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const bytes = Buffer.from(await pdf.save());
  const doc = {
    id: documentId,
    owner_id: owner,
    name: "PPSPS test",
    status: "draft",
    current_storage_path: `${owner}/${documentId}/original.pdf`,
    page_count: 1,
    signing_mode: "parallel",
    workflow_type: "approval",
    completion_mode: "all_after_complete",
    require_full_read: true,
    identity_stamp: true,
    created_at: new Date().toISOString(),
  };
  const signers = [
    {
      id: signerId,
      document_id: documentId,
      name: "Yoann PETIT",
      email: "yoann@example.invalid",
      role: "Responsable travaux",
      signing_order: 1,
      status: "pending",
    },
  ];
  let fields = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      document_id: documentId,
      signer_id: signerId,
      page: 1,
      x: 0.45,
      y: 0.5,
      width: 0.28,
      height: 0.075,
      kind: "date",
      label: "Date de signature",
      required: true,
    },
  ];
  const calls = [];
  await page.addInitScript(
    ({ owner }) => {
      localStorage.setItem(
        "signatureflow-auth",
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user: {
            id: owner,
            email: "owner@example.invalid",
            aud: "authenticated",
          },
        }),
      );
    },
    { owner },
  );
  await page.route(
    "https://signatureflow-test.supabase.co/**",
    async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      const json = (data, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      if (path.startsWith("/storage/v1/object/"))
        return route.fulfill({
          status: 200,
          contentType: "application/pdf",
          body: bytes,
        });
      if (path === "/auth/v1/user")
        return json({ id: owner, email: "owner@example.invalid" });
      if (path === "/rest/v1/signatureflow_documents")
        return json(
          req.headers().accept?.includes("vnd.pgrst.object") ? doc : [doc],
        );
      if (path === "/rest/v1/signatureflow_signers") return json(signers);
      if (path === "/rest/v1/signatureflow_signature_fields")
        return json(fields);
      if (
        path === "/rest/v1/signatureflow_contacts" ||
        path === "/rest/v1/signatureflow_audit_events"
      )
        return json([]);
      if (path === "/rest/v1/rpc/signatureflow_save_fields") {
        calls.push({ step: "save", body: req.postDataJSON() });
        fields = req.postDataJSON().p_fields;
        return json(null);
      }
      if (path === "/rest/v1/rpc/signatureflow_confirm_preparation") {
        calls.push({ step: "confirm" });
        return json((doc.prepared_at = new Date().toISOString()));
      }
      if (path === "/functions/v1/signatureflow-invite-signer") {
        calls.push({ step: "issue", body: req.postDataJSON() });
        if (failIssue)
          return json(
            { error: "Création du lien temporairement indisponible" },
            500,
          );
        doc.status = "in_progress";
        return json({
          links: [
            {
              ...signers[0],
              url: "https://example.invalid/#sign=test",
              expires: "2026-12-04T12:00:00Z",
            },
          ],
          sent: 0,
        });
      }
      throw new Error(`Unexpected request: ${req.method()} ${path}`);
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?document=${documentId}`);
  await expect(page.locator("#stage canvas")).toBeVisible();
  return calls;
}

test("mobile changes an existing date zone to signature and creates the link", async ({
  page,
}) => {
  const calls = await openDraft(page);
  await page.locator("[data-field]").click();
  await page.locator("#fieldKind").selectOption("signature");
  await expect(page.locator(".sig-field")).toContainText("Signature");
  await page.locator("#confirmPreparation").check();
  await page.locator("#shareLinks").click();
  await expect(page.locator(".link-card")).toContainText("Lien prêt");
  expect(calls.map((c) => c.step)).toEqual(["save", "confirm", "issue"]);
  expect(calls[0].body.p_fields[0]).toMatchObject({
    signer_id: signerId,
    kind: "signature",
  });
});

test("choosing a type for a new zone does not change an existing date; validation offers an explicit repair", async ({
  page,
}) => {
  const calls = await openDraft(page);
  await page.locator("[data-field]").click();
  await page.locator("#manualSigner").selectOption(signerId);
  await page.locator("#manualKind").selectOption("signature");
  await page.locator("#confirmPreparation").check();
  await page.locator("#shareLinks").click();
  await expect(page.locator("#preparationFeedback")).toContainText(
    "zone de signature",
  );
  expect(calls).toEqual([]);
  await page
    .getByRole("button", { name: /Transformer.*en zone Signature/ })
    .click();
  await expect(page.locator(".sig-field")).toContainText("Signature");
  await page.locator("#confirmPreparation").check();
  await page.locator("#shareLinks").click();
  await expect(page.locator(".link-card")).toContainText("Lien prêt");
  expect(calls.map((c) => c.step)).toEqual(["save", "confirm", "issue"]);
});

test("server failure remains visible beside the create-links button and allows a retry", async ({
  page,
}) => {
  await openDraft(page, { failIssue: true });
  await page.locator("[data-field]").click();
  await page.locator("#fieldKind").selectOption("signature");
  await page.locator("#confirmPreparation").check();
  await page.locator("#shareLinks").click();
  await expect(page.locator("#preparationFeedback")).toContainText(
    "temporairement indisponible",
  );
  await expect(page.locator("#shareLinks")).toBeEnabled();
  await expect(page.locator(".link-card")).toHaveCount(0);
});
