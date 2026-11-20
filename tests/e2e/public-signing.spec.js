import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
test("external signer needs no account and sees why confirmation is grey until the PDF is read", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const hash = createHash("sha256").update(bytes).digest("hex");
  let authRequests = 0;
  await page.route(
    "https://signatureflow-test.supabase.co/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/auth/")) {
        authRequests++;
        return route.fulfill({ status: 401, json: { error: "no account" } });
      }
      if (path.startsWith("/storage/"))
        return route.fulfill({ contentType: "application/pdf", body: bytes });
      if (path.endsWith("/signatureflow-get-signing-context"))
        return route.fulfill({
          json: {
            blocked: false,
            signer: {
              name: "Responsable Externe",
              email: "externe@example.fr",
              role: "RSO",
              status: "pending",
            },
            document: {
              name: "ISF test",
              signedUrl:
                "https://signatureflow-test.supabase.co/storage/test.pdf",
              sha256: hash,
              revision: 1,
              status: "in_progress",
              pageCount: 2,
              workflowType: "acknowledgement",
              requireFullRead: true,
            },
            fields: [
              {
                id: "field",
                kind: "signature",
                page: 2,
                x: 0.1,
                y: 0.2,
                width: 0.5,
                height: 0.15,
              },
            ],
          },
        });
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/#sign=" + "a".repeat(64));
  await expect(page.locator("#submitSignature")).toBeDisabled();
  await expect(page.locator("#signingGate")).toContainText("1 page(s)");
  await page
    .getByRole("button", { name: "Consulter la prochaine page non lue" })
    .click();
  await expect(page.locator("#submitSignature")).toBeEnabled();
  await expect(page.locator("#signingGate")).toContainText("Toutes les pages");
  expect(authRequests).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
