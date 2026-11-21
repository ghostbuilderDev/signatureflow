import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const owner = "11111111-1111-4111-8111-111111111111";
const docId = "22222222-2222-4222-8222-222222222222";
const alice = "33333333-3333-4333-8333-333333333331";
const bob = "33333333-3333-4333-8333-333333333332";
const first = "44444444-4444-4444-8444-444444444441";
const extra = "44444444-4444-4444-8444-444444444442";
const other = "44444444-4444-4444-8444-444444444443";
const people = [
  {
    id: alice,
    document_id: docId,
    name: "Alice Test",
    email: "alice@example.invalid",
    role: "Responsable travaux",
    signing_order: 1,
    status: "pending",
  },
  {
    id: bob,
    document_id: docId,
    name: "Bob Test",
    email: "bob@example.invalid",
    role: "Responsable entreprise",
    signing_order: 2,
    status: "pending",
  },
];
async function fixture(
  page,
  {
    noSigners = false,
    onlyAlice = false,
    locked = false,
    refuseDelete = false,
  } = {},
) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 53; i++) pdf.addPage([595, 842]);
  const bytes = Buffer.from(await pdf.save());
  const state = {
    doc: {
      id: docId,
      owner_id: owner,
      name: "CSF multi-signataires",
      status: locked ? "in_progress" : "draft",
      current_storage_path: `${owner}/${docId}/original.pdf`,
      page_count: 53,
      signing_mode: "parallel",
      workflow_type: "approval",
      completion_mode: "all_after_complete",
      require_full_read: true,
      identity_stamp: true,
      created_at: new Date().toISOString(),
    },
    signers: noSigners
      ? []
      : structuredClone(onlyAlice ? people.slice(0, 1) : people),
    fields: [
      {
        id: first,
        document_id: docId,
        signer_id: noSigners ? null : alice,
        page: 33,
        x: 0.12,
        y: 0.6,
        width: 0.28,
        height: 0.08,
        kind: "signature",
        label: "Signature A",
        required: true,
      },
      {
        id: extra,
        document_id: docId,
        signer_id: noSigners ? null : alice,
        page: 33,
        x: 0.12,
        y: 0.4,
        width: 0.6,
        height: 0.12,
        kind: "signature",
        label: "Zone en trop",
        required: true,
      },
      {
        id: other,
        document_id: docId,
        signer_id: noSigners || onlyAlice ? null : bob,
        page: 40,
        x: 0.55,
        y: 0.65,
        width: 0.28,
        height: 0.08,
        kind: "signature",
        label: "Signature B",
        required: true,
      },
    ],
    calls: [],
  };
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
  await page.route(
    "https://signatureflow-test.supabase.co/**",
    async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      if (path.startsWith("/storage/v1/object/"))
        return route.fulfill({ contentType: "application/pdf", body: bytes });
      if (path === "/auth/v1/user")
        return route.fulfill({
          json: { id: owner, email: "owner@example.invalid" },
        });
      if (path === "/rest/v1/signatureflow_documents") {
        if (req.method() === "PATCH") {
          Object.assign(state.doc, req.postDataJSON());
          return route.fulfill({ json: null });
        }
        return route.fulfill({
          json: req.headers().accept?.includes("vnd.pgrst.object")
            ? state.doc
            : [state.doc],
        });
      }
      if (path === "/rest/v1/signatureflow_signers") {
        if (req.method() === "DELETE") {
          const id = url.searchParams.get("id").replace("eq.", "");
          state.calls.push({ action: "deleteSigner", id });
          if (refuseDelete)
            return route.fulfill({
              status: 500,
              json: { message: "Suppression temporairement refusée" },
            });
          state.signers = state.signers.filter((s) => s.id !== id);
          state.fields = state.fields.filter((f) => f.signer_id !== id);
          return route.fulfill({ json: null });
        }
        if (req.method() === "POST") {
          state.signers.push({ ...req.postDataJSON(), status: "pending" });
          return route.fulfill({ json: null });
        }
        return route.fulfill({ json: state.signers });
      }
      if (path === "/rest/v1/signatureflow_signature_fields")
        return route.fulfill({ json: state.fields });
      if (path === "/rest/v1/signatureflow_contacts")
        return route.fulfill({ json: [{ ...people[1], owner_id: owner }] });
      if (path === "/rest/v1/signatureflow_audit_events")
        return route.fulfill({ json: [] });
      if (path === "/rest/v1/rpc/signatureflow_save_fields") {
        const body = req.postDataJSON();
        state.calls.push({ action: "save", body });
        state.fields = body.p_fields.map((f) => ({ ...f, document_id: docId }));
        return route.fulfill({ json: null });
      }
      if (path === "/rest/v1/rpc/signatureflow_confirm_preparation") {
        state.calls.push({ action: "confirm" });
        state.doc.prepared_at = new Date().toISOString();
        return route.fulfill({ json: state.doc.prepared_at });
      }
      if (path === "/functions/v1/signatureflow-invite-signer") {
        state.calls.push({ action: "issue", body: req.postDataJSON() });
        state.doc.status = "in_progress";
        return route.fulfill({
          json: {
            links: state.signers.map((s) => ({
              ...s,
              url: `https://example.invalid/#sign=${s.id}`,
              expires: "2026-12-01T12:00:00Z",
            })),
            sent: 0,
          },
        });
      }
      throw new Error(`Unexpected request: ${req.method()} ${path}`);
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?document=${docId}`);
  await expect(page.locator("#stage canvas")).toBeVisible();
  return state;
}
async function select(page, id) {
  await page.locator(`[data-field="${id}"]`).click();
  await expect(page.locator("#selectedZoneTools")).toBeVisible();
}

test("phone deletes an unassigned duplicate beside the PDF without requiring a signer, then restores it", async ({
  page,
}) => {
  const state = await fixture(page, { noSigners: true });
  await select(page, extra);
  await expect(page.locator("#pageInput")).toHaveValue("33");
  await page.locator("#selectedDeleteField").click();
  await expect(page.locator("#zoneCount")).toHaveText("2");
  await expect(page.locator(`[data-field="${extra}"]`)).toHaveCount(0);
  await expect(page.locator("#signerSummary")).toContainText("0 signataire");
  await page
    .getByRole("button", { name: "Annuler la dernière suppression" })
    .click();
  await expect(page.locator("#zoneCount")).toHaveText("3");
  await expect(page.locator(`[data-field="${extra}"]`)).toHaveCount(1);
  await page.locator(`[data-delete-zone="${extra}"]`).click();
  await expect(page.locator("#zoneCount")).toHaveText("2");
  expect(state.calls).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("deleting Alice's extra zone preserves both people and all of Bob's geometry after save and reload", async ({
  page,
}) => {
  const state = await fixture(page);
  const bobField = structuredClone(state.fields.find((f) => f.id === other));
  await select(page, extra);
  await page.locator("#selectedDeleteField").click();
  await expect(page.locator("#signerList .signer-item")).toHaveCount(2);
  await page.locator("#save").click();
  await expect(page.locator("#savedState")).toContainText("enregistrées");
  expect(state.fields).toHaveLength(2);
  expect(state.fields.find((f) => f.id === other)).toMatchObject(bobField);
  expect(state.calls.map((c) => c.action)).toEqual(["save"]);
  await page.reload();
  await expect(page.locator("#zoneCount")).toHaveText("2");
  await expect(page.locator("#signerList .signer-item")).toHaveCount(2);
  await expect(page.locator(`[data-field="${extra}"]`)).toHaveCount(0);
});

test("changing attribution clears its review and final validation detects a person without a signature", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.locator(`[data-delete-zone="${extra}"]`).click();
  await select(page, first);
  await page.locator("#selectedSigner").selectOption(bob);
  await expect(page.locator("#selectedConfirmed")).not.toBeChecked();
  await page.locator("#selectedSaveFields").click();
  await expect(page.locator("#notice")).toContainText("Attribuez et vérifiez");
  expect(state.calls).toHaveLength(0);
  await page.locator("#selectedConfirmed").check();
  await page.locator("#selectedSaveFields").click();
  await expect(page.locator("#notice")).toContainText(
    "Il manque une zone de signature ou de paraphe pour Alice Test",
  );
  expect(state.calls).toHaveLength(0);
  await page.locator("#selectedSigner").selectOption(alice);
  await page.locator("#selectedConfirmed").check();
  await page.locator("#selectedSaveFields").click();
  await expect(page.locator("#savedState")).toContainText("enregistrées");
  expect(state.fields.find((f) => f.id === first).signer_id).toBe(alice);
  expect(state.fields.find((f) => f.id === other).signer_id).toBe(bob);
});

test("removing one person explicitly warns about their zones, can be cancelled and never deletes another person's zones", async ({
  page,
}) => {
  const state = await fixture(page);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Ses 1 zone(s)");
    await dialog.dismiss();
  });
  await page
    .getByRole("button", { name: "Retirer Bob Test", exact: true })
    .click();
  await expect(page.locator("#signerList .signer-item")).toHaveCount(2);
  expect(state.calls).toHaveLength(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Les autres signataires");
    await dialog.accept();
  });
  await page
    .getByRole("button", { name: "Retirer Bob Test", exact: true })
    .click();
  await expect(page.locator("#signerList .signer-item")).toHaveCount(1);
  await expect(page.locator("#zoneCount")).toHaveText("2");
  await expect(page.locator("#signerList")).toContainText("Alice Test");
  expect(state.signers.map((s) => s.id)).toEqual([alice]);
  expect(state.fields.every((f) => f.signer_id === alice)).toBe(true);
  await expect(page.locator(".contact-book summary")).toContainText("1");
});

test("a failed recipient removal retains the person and all local zones", async ({
  page,
}) => {
  const state = await fixture(page, { refuseDelete: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Retirer Bob Test", exact: true })
    .click();
  await expect(page.locator("#notice")).toContainText(
    "Suppression temporairement refusée",
  );
  await expect(page.locator("#signerList .signer-item")).toHaveCount(2);
  await expect(page.locator("#zoneCount")).toHaveText("3");
  expect(state.signers).toHaveLength(2);
});

test("a prefilled second contact must be added, then their own shortcut places an independent signature", async ({
  page,
}) => {
  const state = await fixture(page, { onlyAlice: true });
  await page.locator("#savedContact").selectOption(bob);
  await expect(page.locator("#signerFormHint")).toContainText("prérempli");
  await page.locator("#saveContact").uncheck();
  await page.locator("#save").click();
  await expect(page.locator("#notice")).toContainText(
    "encore dans le formulaire",
  );
  expect(state.calls).toHaveLength(0);
  await page.getByRole("button", { name: "+ Ajouter ce signataire" }).click();
  await expect(page.locator("#signerSummary")).toContainText("2 signataire");
  await page
    .getByRole("button", {
      name: "Placer une signature pour Bob Test",
      exact: true,
    })
    .click();
  await page.locator("#stage").click({ position: { x: 60, y: 100 } });
  await expect(page.locator("#zoneCount")).toHaveText("4");
  const bobRow = page
    .locator("#signerList .signer-item")
    .filter({ hasText: "Bob Test" });
  await expect(bobRow).toContainText("1 signature(s)");
  const aliceRow = page
    .locator("#signerList .signer-item")
    .filter({ hasText: "Alice Test" });
  await expect(aliceRow).toContainText("2 signature(s)");
});

test("two reviewed signers create separate personal links and the issued document cannot be edited", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.locator(`[data-delete-zone="${extra}"]`).click();
  await page.locator("#confirmPreparation").check();
  await page.locator("#shareLinks").click();
  await expect(page.locator("#linkList .link-card")).toHaveCount(2);
  await expect(page.locator("#linkList")).toContainText("Alice Test");
  await expect(page.locator("#linkList")).toContainText("Bob Test");
  expect(state.calls.map((c) => c.action)).toEqual([
    "save",
    "confirm",
    "issue",
  ]);
  expect(state.calls.at(-1).body.delivery).toBe("links");
  await expect(page.locator("[data-delete-zone]")).toHaveCount(0);
  await expect(page.locator(".remove-signer")).toHaveCount(0);
});
