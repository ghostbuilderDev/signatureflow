import { test, expect } from "@playwright/test";
import * as lib from "pdf-lib";
async function digitalPdf() {
  const pdf = await lib.PDFDocument.create(),
    page = pdf.addPage([595, 842]),
    font = await pdf.embedFont(lib.StandardFonts.Helvetica);
  page.drawText("Briefing chantier - Montereau", {
    x: 50,
    y: 770,
    size: 22,
    font,
  });
  page.drawText("Prendre connaissance des travaux avant toute intervention.", {
    x: 50,
    y: 730,
    size: 11,
    font,
  });
  page.drawText("Signature Alice Dupont", { x: 50, y: 260, size: 12, font });
  page.drawText("Signature Bob Martin", { x: 330, y: 260, size: 12, font });
  page.drawLine({ start: { x: 50, y: 180 }, end: { x: 250, y: 180 } });
  page.drawLine({ start: { x: 330, y: 180 }, end: { x: 530, y: 180 } });
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}
async function importDemo(page, bytes) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Essayer l’analyse sur mon PDF" })
    .click();
  await page
    .locator("#file")
    .setInputFiles({
      name: "Briefing-test.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
  await page.getByRole("button", { name: "Importer et préparer" }).click();
  await expect(page.locator("#stage canvas")).toBeVisible();
}
async function addSigner(page, name, email) {
  await page.locator("#signerName").fill(name);
  await page.locator("#signerEmail").fill(email);
  await page.getByRole("button", { name: "+ Ajouter un signataire" }).click();
  await expect(page.locator("#signerList")).toContainText(name);
}
test("desktop imports PDF, detects separate signature blocks, requires review, moves and saves zones", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await importDemo(page, await digitalPdf());
  await addSigner(page, "Alice Dupont", "alice@example.fr");
  await addSigner(page, "Bob Martin", "bob@example.fr");
  await page.locator("#ocrMode").selectOption("never");
  await page
    .getByRole("button", { name: "Analyser le PDF", exact: true })
    .click();
  await expect(page.locator("#zoneCount")).toHaveText("2");
  await expect(page.locator(".unconfirmed")).toHaveCount(2);
  await page.getByRole("button", { name: "Enregistrer les zones" }).click();
  await expect(page.locator("#notice")).toContainText("vérifiez");
  for (let i = 0; i < 2; i++) {
    await page.locator("[data-field]").nth(i).click();
    await page.locator("#fieldConfirmed").check();
  }
  await page.getByRole("button", { name: "Enregistrer les zones" }).click();
  await expect(page.locator("#savedState")).toContainText("validées");
  await page.locator("[data-field]").first().click();
  const field = page.locator(".sig-field.active"),
    box = await field.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 20,
    box.y + box.height / 2 + 10,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(page.locator("#savedState")).toContainText("Modifications");
  await page.locator("#manualSigner").selectOption({ label: "Alice Dupont" });
  await page.locator("#manualKind").selectOption("date");
  await page.getByRole("button", { name: "+ Placer sur la page" }).click();
  await page.locator("#stage").click({ position: { x: 50, y: 100 } });
  await expect(page.locator("#zoneCount")).toHaveText("3");
  await page.screenshot({
    path: "test-results/editor-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("mobile analyzes scanned PDF with local OCR assets and no horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // Build a true image-only PDF to exercise OCR, not a synthetic token mock.
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 1600;
    const x = c.getContext("2d");
    x.fillStyle = "white";
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "black";
    x.font = "bold 48px Arial";
    x.fillText("BRIEFING CHANTIER", 100, 140);
    x.font = "36px Arial";
    x.fillText("Document de prise de connaissance", 100, 240);
    x.fillText("Signature Alice Dupont", 100, 1050);
    x.strokeStyle = "black";
    x.lineWidth = 2;
    x.strokeRect(90, 1080, 550, 240);
    return c.toDataURL("image/png");
  });
  const pdf = await lib.PDFDocument.create(),
    p = pdf.addPage([600, 800]),
    img = await pdf.embedPng(image);
  p.drawImage(img, { x: 0, y: 0, width: 600, height: 800 });
  await importDemo(page, Buffer.from(await pdf.save()));
  await addSigner(page, "Alice Dupont", "alice@example.fr");
  await page
    .getByRole("button", { name: "Analyser le PDF", exact: true })
    .click();
  await expect(page.locator("#analysisStatus")).toContainText("1 page(s) OCR", {
    timeout: 80000,
  });
  await expect(page.locator("#zoneCount")).not.toHaveText("0");
  await expect(page.locator("#analysisStatus")).not.toContainText(
    "indisponible",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/editor-mobile.png",
    fullPage: true,
  });
});
