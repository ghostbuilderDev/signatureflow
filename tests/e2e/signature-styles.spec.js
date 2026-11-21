import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import * as pdfLib from "pdf-lib";
import { createHash } from "node:crypto";
import {
  pngBytes,
  stampPdf,
} from "../../supabase/functions/_shared/pdf-tools.mjs";

async function fixture(
  page,
  {
    name = "Élodie D’Hôtel-Petit",
    initials = true,
    fullRead = false,
    pages = 1,
    status = "pending",
    blocked = false,
  } = {},
) {
  const pdf = await PDFDocument.create();
  for (let p = 0; p < pages; p++) pdf.addPage([595, 842]);
  const bytes = Buffer.from(await pdf.save());
  const fields = [
    {
      id: "signature-1",
      kind: "signature",
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.12,
    },
    {
      id: "signature-2",
      kind: "signature",
      page: pages,
      x: 0.1,
      y: 0.4,
      width: 0.5,
      height: 0.12,
    },
    ...(initials
      ? [
          {
            id: "initials-1",
            kind: "initials",
            page: 1,
            x: 0.1,
            y: 0.6,
            width: 0.2,
            height: 0.12,
          },
        ]
      : []),
  ];
  const submitted = [];
  let authRequests = 0;
  await page.route(
    "https://signatureflow-test.supabase.co/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/auth/")) {
        authRequests++;
        return route.fulfill({ status: 401, json: {} });
      }
      if (path.startsWith("/storage/"))
        return route.fulfill({ contentType: "application/pdf", body: bytes });
      if (path.endsWith("/signatureflow-get-signing-context"))
        return route.fulfill({
          json: {
            blocked,
            signer: {
              name,
              email: "signataire@example.invalid",
              role: "Responsable travaux",
              status,
            },
            document: {
              name: "Document de test manuscrit",
              signedUrl:
                "https://signatureflow-test.supabase.co/storage/test.pdf",
              sha256: createHash("sha256").update(bytes).digest("hex"),
              revision: 1,
              status: "in_progress",
              pageCount: pages,
              workflowType: "approval",
              requireFullRead: fullRead,
            },
            fields,
          },
        });
      if (path.endsWith("/signatureflow-submit-signature")) {
        const body = route.request().postDataJSON();
        // Exercise the actual unchanged PDF stamping code with the emitted PNGs.
        const result = await stampPdf(
          await PDFDocument.load(bytes),
          fields,
          {
            signature: pngBytes(body.signatureDataUrl),
            initials: body.initialsDataUrl
              ? pngBytes(body.initialsDataUrl)
              : undefined,
            typedName: body.typedName,
            signedAt: new Date(),
            identityStamp: true,
            values: {},
          },
          pdfLib,
        );
        expect((await PDFDocument.load(result)).getPageCount()).toBe(pages);
        submitted.push(body);
        return route.fulfill({
          json: { sha256: createHash("sha256").update(result).digest("hex") },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/#sign=" + "a".repeat(64));
  await expect(page.locator("#signPageLabel")).toContainText("Page 1");
  return { submitted, authRequests: () => authRequests };
}
async function ready(page) {
  await expect(page.locator("#adoptSignature")).toBeEnabled();
  await expect(page.locator(".signature-style img:visible")).toHaveCount(3);
}
async function draw(page, selector) {
  const canvas = page.locator(selector);
  await canvas.scrollIntoViewIfNeeded();
  await expect.poll(() => canvas.evaluate((c) => c.width > 300)).toBeTruthy();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 80);
  await page.mouse.down();
  for (let i = 1; i < 12; i++)
    await page.mouse.move(box.x + 20 + i * 8, box.y + 80 + (i % 2 ? -18 : 18));
  await page.mouse.up();
}

for (const [id, label] of [
  ["elegant", "Élégant"],
  ["fluid", "Fluide"],
  ["natural", "Naturel"],
]) {
  test(`PC: ${label}, adoption, initials and two PDF boxes without drawing`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await ready(page);
    await expect(
      page.locator('[name="signatureMode"][value="name"]'),
    ).toBeChecked();
    await expect(page.locator("#typedName")).toHaveAttribute("readonly", "");
    await page.locator(`[name="handwritingStyle"][value="${id}"]`).check();
    const preview = await page
      .locator(`[data-style="${id}"] img`)
      .getAttribute("src");
    const initials = await page
      .locator("#generatedInitials")
      .getAttribute("src");
    await page.locator("#submitSignature").click();
    await expect(page.locator("#notice")).toContainText("J’adopte");
    expect(state.submitted).toHaveLength(0);
    await page.locator("#adoptSignature").check();
    await page.locator("#submitSignature").click();
    await expect(page.locator("#notice")).toContainText("consentement");
    expect(state.submitted).toHaveLength(0);
    await page.locator("#consent").check();
    await page.locator("#submitSignature").click();
    await expect(
      page.getByRole("heading", { name: "Merci, Élodie D’Hôtel-Petit." }),
    ).toBeVisible();
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0].signatureDataUrl).toBe(preview);
    expect(state.submitted[0].initialsDataUrl).toBe(initials);
    expect(state.submitted[0].typedName).toBe("Élodie D’Hôtel-Petit");
    expect(state.authRequests()).toBe(0);
  });
}

test("changing style or method invalidates adoption and consent; drawing is preserved on switch and resize", async ({
  page,
}) => {
  await fixture(page);
  await ready(page);
  await page.locator("#adoptSignature").check();
  await page.locator("#consent").check();
  await page.locator('[name="handwritingStyle"][value="fluid"]').check();
  await expect(page.locator("#adoptSignature")).not.toBeChecked();
  await expect(page.locator("#consent")).not.toBeChecked();
  await page.locator('[name="signatureMode"][value="draw"]').check();
  await draw(page, "#signatureCanvas");
  await draw(page, "#initialsCanvas");
  const before = await page
    .locator("#signatureCanvas")
    .evaluate((c) => c.toDataURL());
  await page.locator('[name="signatureMode"][value="name"]').check();
  await page.locator("#adoptSignature").check();
  await page.locator("#consent").check();
  await page.locator('[name="signatureMode"][value="draw"]').check();
  await expect(page.locator("#consent")).not.toBeChecked();
  expect(
    await page.locator("#signatureCanvas").evaluate((c) => c.toDataURL()),
  ).toBe(before);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect
    .poll(() =>
      page
        .locator("#signatureCanvas")
        .evaluate(
          (c) => c.width === Math.round(c.clientWidth * devicePixelRatio),
        ),
    )
    .toBeTruthy();
  await page.locator("#consent").check();
  await page.locator("#clearSignature").click();
  await expect(page.locator("#consent")).not.toBeChecked();
  await page.locator("#consent").check();
  await page.locator("#submitSignature").click();
  await expect(page.locator("#notice")).toContainText("Tracez votre signature");
  await draw(page, "#signatureCanvas");
  await page.locator("#consent").check();
  await page.locator("#submitSignature").click();
  await expect(page.getByRole("heading", { name: /^Merci,/ })).toBeVisible();
});

test("full PDF reading remains required with a generated signature", async ({
  page,
}) => {
  const state = await fixture(page, {
    fullRead: true,
    pages: 2,
    initials: false,
  });
  await ready(page);
  await page.locator("#adoptSignature").check();
  await page.locator("#consent").check();
  await expect(page.locator("#submitSignature")).toBeDisabled();
  expect(state.submitted).toHaveLength(0);
  await page.locator("#goUnread").click();
  await expect(page.locator("#submitSignature")).toBeEnabled();
  await page.locator("#submitSignature").click();
  await expect(page.getByRole("heading", { name: /^Merci,/ })).toBeVisible();
  expect(state.submitted[0].readPages).toEqual([1, 2]);
  expect(state.submitted[0].initialsDataUrl).toBeUndefined();
});

test("font failure never adopts a fallback font; other styles and drawing still work", async ({
  page,
}) => {
  await page.route("**/*allura*woff*", (route) => route.abort());
  const state = await fixture(page, { initials: false });
  await expect(page.locator("#signatureStyleStatus")).toContainText(
    "n’a pas pu être chargée",
  );
  await expect(page.locator("#adoptSignature")).toBeDisabled();
  await page.locator("#submitSignature").click();
  expect(state.submitted).toHaveLength(0);
  await page.locator('[name="handwritingStyle"][value="natural"]').check();
  await expect(page.locator("#adoptSignature")).toBeEnabled();
  await page.locator("#adoptSignature").check();
  await page.locator("#consent").check();
  await page.locator("#submitSignature").click();
  await expect(page.getByRole("heading", { name: /^Merci,/ })).toBeVisible();
});

test("three different transparent PNGs fit long accented names with no clipped ink", async ({
  page,
}) => {
  const name = "Éléonore Marie-Clémence D’Hôtel de Saint-Étienne "
    .repeat(3)
    .slice(0, 160)
    .trim();
  await fixture(page, { name });
  await ready(page);
  const images = await page
    .locator(".signature-style img")
    .evaluateAll(async (imgs) =>
      Promise.all(
        imgs.map(async (img) => {
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let ink = 0,
            edge = 0;
          for (let y = 0; y < c.height; y++)
            for (let x = 0; x < c.width; x++)
              if (data[(y * c.width + x) * 4 + 3]) {
                ink++;
                if (x < 8 || y < 8 || x >= c.width - 8 || y >= c.height - 8)
                  edge++;
              }
          return { src: img.src, width: c.width, height: c.height, ink, edge };
        }),
      ),
    );
  expect(new Set(images.map((i) => i.src)).size).toBe(3);
  for (const img of images) {
    expect(img.ink).toBeGreaterThan(100);
    expect(img.edge).toBe(0);
    expect(img.width).toBeLessThan(1200);
    expect(img.height).toBeLessThan(300);
  }
});

test("each signer gets their own name, initials and unadopted choice", async ({
  browser,
}) => {
  const images = [];
  for (const name of ["Alice Martin", "Bob Durand"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await fixture(page, { name });
    await ready(page);
    await expect(page.locator("#adoptSignature")).not.toBeChecked();
    images.push(
      await page.locator('[data-style="elegant"] img').getAttribute("src"),
    );
    await context.close();
  }
  expect(images[0]).not.toBe(images[1]);
});

for (const options of [{ status: "signed" }, { blocked: true }]) {
  test(`signed or ordered-blocked links cannot choose or submit: ${JSON.stringify(options)}`, async ({
    page,
  }) => {
    await fixture(page, options);
    await expect(page.locator("#signForm")).toHaveCount(0);
    await expect(page.locator(".signature-choice")).toHaveCount(0);
  });
}

test.describe("touchscreen", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("drawing stays available by default; generated names fit mobile without overflow", async ({
    page,
  }) => {
    await fixture(page);
    await expect(
      page.locator('[name="signatureMode"][value="draw"]'),
    ).toBeChecked();
    await page.locator('[name="signatureMode"][value="name"]').check();
    await ready(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator('[name="handwritingStyle"][value="natural"]').check();
    await page.locator("#adoptSignature").check();
    await page.locator("#consent").check();
    await page.locator("#submitSignature").click();
    await expect(page.getByRole("heading", { name: /^Merci,/ })).toBeVisible();
  });
});
