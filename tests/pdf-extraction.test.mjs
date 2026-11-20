import test from "node:test";
import assert from "node:assert/strict";
import * as lib from "pdf-lib";
import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { detectFromLayout } from "../src/lib/detection-core.js";
test("real PDF.js text geometry locates separate signature columns", async () => {
  const pdf = await lib.PDFDocument.create(),
    p = pdf.addPage([595, 842]),
    font = await pdf.embedFont(lib.StandardFonts.Helvetica);
  p.drawText("Signature Alice Dupont", { x: 50, y: 260, size: 12, font });
  p.drawText("Signature Bob Martin", { x: 330, y: 260, size: 12, font });
  const doc = await getDocument({
    data: await pdf.save(),
    useSystemFonts: true,
  }).promise;
  try {
    const page = await doc.getPage(1),
      view = page.getViewport({ scale: 1 }),
      text = await page.getTextContent();
    const tokens = text.items
      .filter((i) => i.str)
      .map((i) => {
        const t = Util.transform(view.transform, i.transform),
          h = Math.hypot(t[2], t[3]);
        return {
          text: i.str,
          x: t[4] / view.width,
          y: (t[5] - h) / view.height,
          width: i.width / view.width,
          height: h / view.height,
        };
      });
    const found = detectFromLayout({
      page: 1,
      tokens,
      signers: [
        { id: "a", name: "Alice Dupont" },
        { id: "b", name: "Bob Martin" },
      ],
    });
    assert.equal(found.length, 2);
    assert.equal(found[0].suggested_signer_id, "a");
    assert.equal(found[1].suggested_signer_id, "b");
    assert.ok(found[0].y > 0.68 && found[0].y < 0.72);
  } finally {
    await doc.destroy();
  }
});
