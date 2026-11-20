import { test, expect } from "@playwright/test";
const owner = "11111111-1111-4111-8111-111111111111",
  doc = "22222222-2222-4222-8222-222222222222",
  v = "33333333-3333-4333-8333-333333333333";
async function session(page) {
  await page.addInitScript(
    ({ owner }) =>
      localStorage.setItem(
        "signatureflow-auth",
        JSON.stringify({
          access_token: "test-access",
          refresh_token: "test-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: "bearer",
          user: { id: owner, email: "owner@example.invalid" },
        }),
      ),
    { owner },
  );
}
async function backend(page) {
  const calls = [];
  let prepared = false;
  await page.route(
    "https://signatureflow-test.supabase.co/**",
    async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/auth/v1/user")
        return route.fulfill({
          json: { id: owner, email: "owner@example.invalid" },
        });
      if (path !== "/functions/v1/signatureflow-flow")
        return route.fulfill({ json: [] });
      const input = req.postDataJSON();
      calls.push(input);
      const document = {
        id: doc,
        owner_id: owner,
        title: "ISF Samois",
        document_type: "ISF",
        current_version_id: v,
      };
      const version = {
        id: v,
        document_id: doc,
        label: "B",
        state: "current",
        source_sha256: "a".repeat(64),
      };
      const result = {
        list: { documents: [document], versions: [version], canManage: true },
        details: {
          doc: document,
          version,
          canManage: true,
          currentUserId: owner,
          legacyUrl: "https://signature.example.fr/",
          sourceUrl: "https://signature.example.fr/original.pdf",
          campaigns: prepared
            ? [{ id: "campaign", mode: "acknowledgement" }]
            : [],
          mappings: prepared
            ? [{ campaign_id: "campaign", envelope_id: "envelope" }]
            : [],
          envelopes: prepared
            ? [{ id: "envelope", status: "draft", owner_id: owner }]
            : [],
          signers: [],
          recipients: [],
          archives: [],
          events: [],
          jobs: [],
        },
        members: { members: [] },
        createCampaign: { ok: true },
        inbox: {
          items: [
            {
              id: "signer",
              title: "ISF Samois",
              label: "B",
              mode: "acknowledgement",
              role: "RSO",
              url: "https://signature.example.fr/#sign=" + "f".repeat(64),
            },
          ],
        },
        issueAcknowledgement: { ok: true, queued: 1 },
      };
      if (input.action === "createCampaign") prepared = true;
      return route.fulfill({ json: result[input.action] || { ok: true } });
    },
  );
  return calls;
}
test("mobile standalone organizer prepares an external recipient without a JDC identity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await session(page);
  const calls = await backend(page);
  await page.goto("/document-flow.html");
  await page.getByRole("button", { name: "Indice B", exact: false }).click();
  await page.getByRole("button", { name: "Préparer une diffusion" }).click();
  await page.locator('[name="mode"]').selectOption("acknowledgement");
  const row = page.locator(".sf3-recipient");
  await row.locator("[data-name]").fill("Responsable entreprise");
  await row.locator("[data-email]").fill("externe@example.fr");
  await row.locator("[data-role]").fill("RSO");
  await row.locator("[data-company]").fill("Entreprise externe");
  await page.locator("[name=reviewed]").check();
  await page
    .getByRole("button", { name: "Préparer les dossiers de signature" })
    .click();
  await expect(
    page.getByRole("button", { name: "Valider et envoyer les invitations" }),
  ).toBeVisible();
  const sent = calls.find((c) => c.action === "createCampaign");
  expect(sent.recipients[0].email).toBe("externe@example.fr");
  expect(sent.recipients[0].user_id).toBeUndefined();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Valider et envoyer les invitations" })
    .click();
  await expect
    .poll(() => calls.some((c) => c.action === "issueAcknowledgement"))
    .toBeTruthy();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("CSV import removes the unused empty row and keeps mandatory role validation", async ({
  page,
}) => {
  await session(page);
  const calls = await backend(page);
  await page.goto("/document-flow.html");
  await page.getByRole("button", { name: "Indice B", exact: false }).click();
  await page.getByRole("button", { name: "Préparer une diffusion" }).click();
  await page
    .getByText("Ajouter une liste de destinataires", { exact: true })
    .click();
  await page
    .locator("[data-csv]")
    .fill(
      "Alice;alice@example.fr;RSO;Entreprise A\nBob;bob@example.fr;Responsable;Entreprise B",
    );
  await page
    .getByRole("button", { name: "Ajouter la liste", exact: true })
    .click();
  await expect(page.locator(".sf3-recipient")).toHaveCount(2);
  await page.locator("[name=reviewed]").check();
  await page
    .getByRole("button", { name: "Préparer les dossiers de signature" })
    .click();
  await expect
    .poll(
      () => calls.find((c) => c.action === "createCampaign")?.recipients.length,
    )
    .toBe(2);
});
test("native JDC inbox does not interrupt text entry and signs using an external link", async ({
  page,
}) => {
  await backend(page);
  await page.route("**/jdc-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<html><head><link rel="stylesheet" href="/integration/document-flow.css"></head><body><div class="documentation-header"></div><input id="entry"><script src="/integration/document-flow-ui.js"></script><script src="/integration/jdc/signatureflow-bridge.js"></script></body></html>`,
    }),
  );
  await page.goto("/jdc-fixture");
  await page.locator("#entry").fill("Saisie en cours");
  await page.evaluate(
    ({ owner }) => {
      window.fixtureState = {
        user: { id: owner },
        chantierId: "site",
        siteName: "Samois",
        cloud: true,
        canManage: true,
        documents: [],
        folders: [],
      };
      window.fixtureBridge = window.JournalSignatureFlow.create({
        getState: () => window.fixtureState,
        getClient: () => ({
          auth: {
            getSession: async () => ({
              data: { session: { access_token: "current" } },
            }),
          },
        }),
        supabaseUrl: "https://signatureflow-test.supabase.co",
        publicKey: "test",
      });
    },
    { owner },
  );
  await expect(page.locator(".sf3-inbox-trigger")).toBeVisible();
  await expect(page.locator(".sf3-inbox-notice")).toHaveCount(0);
  await expect(page.locator("#entry")).toBeFocused();
  await page.locator(".sf3-inbox-trigger").click();
  const a = page.getByRole("link", { name: "Consulter et signer" });
  await expect(a).toHaveAttribute("href", /\/#sign=/);
  await page.evaluate(async () => {
    window.fixtureState.user = null;
    await window.fixtureBridge.refresh();
  });
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator(".sf3-inbox-trigger")).toHaveCount(0);
});
