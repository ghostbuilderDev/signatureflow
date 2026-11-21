import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

async function pdfFile(name = "Briefing-glisse.pdf") {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  };
}
async function demo(page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Essayer l’analyse sur mon PDF" })
    .click();
  await expect(page.locator("[data-pdf-dropzone]")).toBeVisible();
}
async function transfer(page, files) {
  return page.evaluateHandle(
    (payloads) => {
      const data = new DataTransfer();
      for (const file of payloads)
        data.items.add(
          new File([new Uint8Array(file.bytes)], file.name, {
            type: file.mimeType,
          }),
        );
      return data;
    },
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      bytes: [...file.buffer],
    })),
  );
}
async function drop(page, files, target = "[data-pdf-dropzone]") {
  const dataTransfer = await transfer(page, files);
  await page.locator(target).dispatchEvent("dragenter", { dataTransfer });
  await page.locator(target).dispatchEvent("dragover", { dataTransfer });
  await page.locator(target).dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

test("desktop PDF drop fills the name and imports the actual PDF into the editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await demo(page);
  const file = await pdfFile();
  const dataTransfer = await transfer(page, [file]);
  const zone = page.locator("[data-pdf-dropzone]");
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await expect(zone).toHaveClass(/is-dragging/);
  await zone.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await expect(zone).not.toHaveClass(/is-dragging/);
  await expect(page.locator("[data-pdf-selection]")).toContainText(file.name);
  await expect(page.locator("#docName")).toHaveValue("Briefing-glisse");
  await page.getByRole("button", { name: "Importer et préparer" }).click();
  await expect(page.locator("#stage canvas")).toBeVisible();
});

test("invalid, disguised and multiple files never replace the selected PDF or custom title", async ({
  page,
}) => {
  await demo(page);
  await drop(page, [await pdfFile("Premier.pdf")]);
  await page.locator("#docName").fill("Titre personnalisé");
  const status = page.locator("[data-pdf-status]");
  await drop(page, [
    { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("image") },
  ]);
  await expect(status).toContainText("Choisissez un fichier PDF");
  await drop(page, [
    {
      name: "faux.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("no PDF inside"),
    },
  ]);
  await expect(status).toContainText("n’est pas un PDF valide");
  await drop(page, [await pdfFile("A.pdf"), await pdfFile("B.pdf")]);
  await expect(status).toContainText("un seul fichier");
  await expect(page.locator("[data-pdf-selection]")).toContainText(
    "Premier.pdf",
  );
  await expect(page.locator("#docName")).toHaveValue("Titre personnalisé");
  await page.getByRole("button", { name: "Importer et préparer" }).click();
  await expect(page.locator("#stage canvas")).toBeVisible();
});

test("oversized PDFs are refused and a later valid selection recovers", async ({
  page,
}) => {
  await demo(page);
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], "Trop-grand.pdf", {
        type: "application/pdf",
      }),
    );
    return data;
  });
  await page
    .locator("[data-pdf-dropzone]")
    .dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.locator("[data-pdf-status]")).toContainText(
    "dépasse 20 Mo",
  );
  await expect(page.locator("[data-pdf-selection]")).toHaveText(
    "Aucun fichier sélectionné",
  );
  await page.locator("#file").setInputFiles(await pdfFile("Valide.pdf"));
  await expect(page.locator("[data-pdf-status]")).toContainText(
    "prêt à importer",
  );
  await expect(page.locator("[data-pdf-dropzone]")).not.toHaveClass(
    /has-error/,
  );
});

test("outside file drops cannot navigate away and text drag is left untouched", async ({
  page,
}) => {
  await demo(page);
  const result = await page.evaluate(() => {
    const files = new DataTransfer();
    files.items.add(
      new File(["%PDF-1.7"], "test.pdf", { type: "application/pdf" }),
    );
    const fileEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: files,
    });
    document.body.dispatchEvent(fileEvent);
    const text = new DataTransfer();
    text.setData("text/plain", "texte sélectionné");
    const textEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: text,
    });
    document.body.dispatchEvent(textEvent);
    return {
      filePrevented: fileEvent.defaultPrevented,
      textPrevented: textEvent.defaultPrevented,
    };
  });
  expect(result).toEqual({ filePrevented: true, textPrevented: false });
  await expect(page.locator("#uploadForm")).toBeVisible();
});

test("phone keeps native file selection, waits for validation and has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await page.locator("#file").focus();
  await expect(page.locator("#file")).toBeFocused();
  await page
    .locator("#file")
    .setInputFiles(
      await pdfFile(
        "Document-avec-un-nom-très-long-sur-téléphone-pour-le-chantier.pdf",
      ),
    );
  await expect(page.locator("[data-pdf-selection]")).toContainText(
    "Document-avec-un-nom",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Importer et préparer" }).click();
  await expect(page.locator("#stage canvas")).toBeVisible();
});

test("standalone document versions send the dropped PDF bytes through the existing upload API", async ({
  page,
}) => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const version = "33333333-3333-4333-8333-333333333333";
  const file = await pdfFile("ISF-Samois.pdf");
  const actions = [];
  let uploaded = null;
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
      const path = new URL(route.request().url()).pathname;
      if (path === "/upload-test") {
        uploaded = route.request().postDataBuffer();
        return route.fulfill({ status: 200, body: "" });
      }
      if (path === "/auth/v1/user")
        return route.fulfill({
          json: { id: owner, email: "owner@example.invalid" },
        });
      if (path !== "/functions/v1/signatureflow-flow")
        return route.fulfill({ json: [] });
      const input = route.request().postDataJSON();
      actions.push(input);
      if (input.action === "list")
        return route.fulfill({
          json: { documents: [], versions: [], canManage: true },
        });
      if (input.action === "prepareUpload")
        return route.fulfill({
          json: {
            version: { id: version },
            upload: {
              signedUrl: "https://signatureflow-test.supabase.co/upload-test",
            },
          },
        });
      if (input.action === "details")
        return route.fulfill({
          json: {
            doc: { title: "ISF-Samois", document_type: "ISF" },
            version: { id: version, label: "A", state: "draft" },
            canManage: true,
            currentUserId: owner,
            campaigns: [],
            envelopes: [],
            recipients: [],
            signers: [],
            archives: [],
            events: [],
            jobs: [],
            mappings: [],
          },
        });
      return route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto("/document-flow.html");
  await page.locator("[data-new]").click();
  await drop(page, [file]);
  await expect(page.locator('[name="title"]')).toHaveValue("ISF-Samois");
  await page.locator('[name="label"]').fill("A");
  await page.getByRole("button", { name: "Enregistrer cet indice" }).click();
  await expect
    .poll(() => actions.some((action) => action.action === "finishUpload"))
    .toBe(true);
  expect(uploaded).toEqual(file.buffer);
  expect(
    actions.find((action) => action.action === "prepareUpload"),
  ).toMatchObject({ title: "ISF-Samois", label: "A", chantierId: null });
  expect(
    actions.some((action) => /issue|send|createCampaign/.test(action.action)),
  ).toBe(false);
});
