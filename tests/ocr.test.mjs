import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { resolve } from "node:path";
import {
  detectFromLayout,
  detectRules,
  detectTableCells,
} from "../src/lib/detection-core.js";
test("real French scan OCR plus raster cells detect the intended signature", async () => {
  // CI images need not ship a usable sans-serif font. Render the same fixture everywhere.
  assert.ok(
    GlobalFonts.registerFromPath(
      resolve(
        "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
      ),
      "SignatureFlowTest",
    ),
  );
  assert.ok(
    GlobalFonts.registerFromPath(
      resolve("node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf"),
      "SignatureFlowTest",
    ),
  );
  const canvas = createCanvas(1200, 1600),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 1600);
  ctx.fillStyle = "black";
  ctx.font = "bold 48px SignatureFlowTest";
  ctx.fillText("BRIEFING CHANTIER", 100, 140);
  ctx.font = "36px SignatureFlowTest";
  ctx.fillText("Document de prise de connaissance", 100, 240);
  ctx.fillText("Signature Alice Dupont", 100, 1050);
  ctx.lineWidth = 2;
  ctx.strokeRect(90, 1080, 550, 240);
  const worker = await createWorker("fra+eng", 1, {
    langPath: resolve("public/ocr"),
    cacheMethod: "none",
  });
  try {
    const { data } = await worker.recognize(
      canvas.toBuffer("image/png"),
      {},
      { blocks: true, text: true },
    );
    const words = (data.blocks || [])
      .flatMap((b) => b.paragraphs || [])
      .flatMap((b) => b.lines || [])
      .flatMap((b) => b.words || []);
    assert.ok(words.length > 5, "OCR returns word boxes");
    const tokens = words.map((w) => ({
      text: w.text,
      x: w.bbox.x0 / 1200,
      y: w.bbox.y0 / 1600,
      width: (w.bbox.x1 - w.bbox.x0) / 1200,
      height: (w.bbox.y1 - w.bbox.y0) / 1600,
      source: "ocr",
    }));
    const raster = ctx.getImageData(0, 0, 1200, 1600),
      rules = detectRules(raster),
      cells = detectTableCells(raster, rules);
    const found = detectFromLayout({
      page: 1,
      tokens,
      rules,
      cells,
      signers: [{ id: "a", name: "Alice Dupont" }],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].suggested_signer_id, "a");
    assert.ok(found[0].y > 0.65);
    assert.match(found[0].reason, /OCR/);
    assert.ok(
      found[0].height > 0.05,
      "the signature box uses the available frame height",
    );
  } finally {
    await worker.terminate();
  }
});
