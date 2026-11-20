import test from "node:test";
import assert from "node:assert/strict";
import * as lib from "pdf-lib";
import {
  placement,
  stampPdf,
  validateFields,
  pngBytes,
} from "../supabase/functions/_shared/pdf-tools.mjs";
const img = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
test("crop offsets and rotations map displayed corners correctly", async () => {
  const pdf = await lib.PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const p = pdf.addPage([600, 800]);
    p.setCropBox(20, 30, 500, 700);
    p.setRotation(lib.degrees(rotation));
    const b = placement(p, { x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
    assert.equal(b.width, rotation % 180 ? 210 : 150);
    assert.equal(b.height, rotation % 180 ? 50 : 70);
    assert.equal(b.rotation, rotation);
    assert.ok(b.x >= 20 && b.y >= 30);
    const expected = {
      0: [70, 520],
      90: [170, 100],
      180: [470, 240],
      270: [370, 660],
    };
    assert.deepEqual([Math.round(b.x), Math.round(b.y)], expected[rotation]);
  }
});
test("stamps multiple types on rotated pages and serializes a valid PDF", async () => {
  const pdf = await lib.PDFDocument.create();
  for (const r of [0, 90, 180, 270])
    pdf.addPage([600, 800]).setRotation(lib.degrees(r));
  const fields = [0, 90, 180, 270].map((r, i) => ({
    id: "f" + i,
    page: i + 1,
    x: 0.2,
    y: 0.4,
    width: 0.3,
    height: 0.1,
    kind: "signature",
  }));
  fields.push(
    {
      id: "txt",
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.3,
      height: 0.04,
      kind: "text",
      required: true,
    },
    {
      id: "cb",
      page: 2,
      x: 0.1,
      y: 0.1,
      width: 0.04,
      height: 0.04,
      kind: "checkbox",
      required: true,
    },
  );
  const bytes = await stampPdf(
    pdf,
    fields,
    {
      signature: img,
      typedName: "Yoann Petit 测试",
      signedAt: new Date(),
      values: { txt: "Document lu", cb: true },
    },
    lib,
  );
  const reopened = await lib.PDFDocument.load(bytes);
  assert.equal(reopened.getPageCount(), 4);
  assert.ok(bytes.length > 1000);
});
test("server rejects out of page fields and missing required inputs", async () => {
  assert.throws(
    () =>
      validateFields(
        [{ page: 1, x: 0.9, y: 0.1, width: 0.3, height: 0.1, signer_id: "a" }],
        1,
        [{ id: "a" }],
      ),
    /hors page/,
  );
  assert.throws(
    () =>
      validateFields(
        [
          {
            page: 1,
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.1,
            signer_id: "wrong",
          },
        ],
        1,
        [{ id: "a" }],
      ),
    /incohérent/,
  );
  assert.throws(
    () => pngBytes("data:image/svg+xml;base64,PHN2Zz4="),
    /invalide/,
  );
  const pdf = await lib.PDFDocument.create();
  pdf.addPage();
  await assert.rejects(
    stampPdf(
      pdf,
      [
        {
          page: 1,
          x: 0.1,
          y: 0.1,
          width: 0.3,
          height: 0.1,
          kind: "checkbox",
          required: true,
        },
      ],
      { signature: img, typedName: "Test", signedAt: new Date() },
      lib,
    ),
    /non cochée/,
  );
});
