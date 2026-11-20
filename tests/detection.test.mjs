import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyLabel,
  detectFromLayout,
  detectRules,
  groupLines,
  deduplicate,
  isLikelyTableOfContents,
} from "../src/lib/detection-core.js";
const token = (text, x = 0.1, y = 0.5, width = 0.12, height = 0.015) => ({
  text,
  x,
  y,
  width,
  height,
});
test("ignores narrative and document headers, preserves explicit anchors", () => {
  for (const s of [
    "Signature électronique",
    "La signature du présent document vaut acceptation",
    "Date de signature",
    "Après signature du document",
    "SignatureFlow",
    "Demande de signature",
  ])
    assert.equal(classifyLabel(s), null, s);
  assert.equal(
    classifyLabel("Signature du responsable travaux").kind,
    "signature",
  );
  assert.equal(classifyLabel("{{signature_yoann}}").anchor, "yoann");
  assert.equal(classifyLabel("Paraphe").kind, "initials");
  assert.equal(classifyLabel("Signa ture").kind, "signature");
});
test("reassembles split text without merging distant columns", () => {
  assert.equal(
    groupLines([token("Signa", 0.1, 0.5, 0.04), token("ture", 0.14, 0.5, 0.03)])
      .length,
    1,
  );
  assert.equal(
    groupLines([token("Signature", 0.1), token("Signature", 0.65)]).length,
    2,
  );
});
test("ignores signature words in a table of contents but keeps a structured named block", () => {
  const summary = [
    token("SOMMAIRE", 0.1, 0.08, 0.2),
    token("1 Présentation ........ 2", 0.1, 0.16, 0.5),
    token("2 Organisation ........ 5", 0.1, 0.22, 0.5),
    token("3 Signatures ........ 12", 0.1, 0.28, 0.5),
  ];
  assert.equal(isLikelyTableOfContents(groupLines(summary)), true);
  assert.equal(
    detectFromLayout({ page: 1, tokens: summary, signers: [] }).length,
    0,
  );
  const named = detectFromLayout({
    page: 2,
    tokens: [
      token("Nom et prénom : Alice Dupont", 0.1, 0.5, 0.32),
      token("Fonction : Responsable travaux", 0.1, 0.53, 0.34),
      token("Signature", 0.1, 0.57, 0.12),
    ],
    rules: [{ x: 0.1, y: 0.68, width: 0.35, height: 0.002 }],
    signers: [
      {
        id: "alice",
        name: "Alice Dupont",
        role: "Responsable travaux",
      },
    ],
  });
  assert.equal(named.length, 1);
  assert.equal(named[0].suggested_signer_id, "alice");
});
test("detects two signature blocks, native widgets, no arbitrary signer assignment", () => {
  const tokens = [
    token("Signature du client", 0.1),
    token("Signature du responsable", 0.6),
  ];
  const fields = detectFromLayout({
    page: 1,
    tokens,
    signers: [
      { id: "a", name: "Alice Dupont" },
      { id: "b", name: "Yoann Petit" },
    ],
  });
  assert.equal(fields.length, 2);
  assert.ok(fields.every((f) => !f.suggested_signer_id));
  assert.ok(fields.every((f) => f.y > 0.5));
  const widgets = detectFromLayout({
    page: 2,
    widgets: [
      {
        signature: true,
        x: 0.2,
        y: 0.3,
        width: 0.3,
        height: 0.1,
        label: "Signature Alice Dupont",
      },
    ],
    signers: [{ id: "a", name: "Alice Dupont" }],
  });
  assert.equal(widgets[0].suggested_signer_id, "a");
  assert.equal(widgets[0].confidence, 0.99);
});
test("native fields suppress duplicate labels, stay within page", () => {
  const fields = detectFromLayout({
    page: 1,
    tokens: [token("Signature", 0.1, 0.85)],
    widgets: [{ signature: true, x: 0.1, y: 0.873, width: 0.28, height: 0.1 }],
    signers: [],
  });
  assert.equal(fields.length, 1);
  for (const f of deduplicate([
    { page: 1, x: 0.95, y: 0.98, width: 0.3, height: 0.1, confidence: 0.8 },
  ]))
    assert.ok(f.x + f.width <= 1 && f.y + f.height <= 1);
});
test("detects raster frame and horizontal rules", () => {
  const width = 500,
    height = 700,
    data = new Uint8ClampedArray(width * height * 4).fill(255);
  const dot = (x, y) => {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  };
  for (let x = 50; x <= 220; x++) {
    dot(x, 400);
    dot(x, 480);
  }
  for (let y = 400; y <= 480; y++) {
    dot(50, y);
    dot(220, y);
  }
  const rules = detectRules({ data, width, height });
  assert.ok(rules.some((r) => r.frameHeight > 0.1));
  assert.ok(rules.length >= 2);
});
test("signature tables produce one field per body row with explicit name matching", () => {
  const cells = [0.2, 0.3, 0.4].map((y) => ({
    x: 0.6,
    y,
    width: 0.3,
    height: 0.1,
  }));
  const tokens = [
    token("Signature", 0.62, 0.22, 0.15),
    token("Alice Dupont", 0.15, 0.32),
    token("Bob Martin", 0.15, 0.42),
  ];
  const fields = detectFromLayout({
    page: 1,
    tokens,
    cells,
    signers: [
      { id: "a", name: "Alice Dupont" },
      { id: "b", name: "Bob Martin" },
    ],
  });
  assert.equal(fields.length, 2);
  assert.equal(fields[0].suggested_signer_id, "a");
  assert.equal(fields[1].suggested_signer_id, "b");
  assert.ok(fields.every((f) => f.reason.includes("tableau")));
});
