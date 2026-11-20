import test from "node:test";
import assert from "node:assert/strict";
import * as lib from "pdf-lib";
import {
  normalizeRecipients,
  batches,
  buildEnvelope,
} from "../supabase/functions/_shared/flow-core.mjs";
import { validateFields } from "../supabase/functions/_shared/pdf-tools.mjs";
test("external recipients require no JDC id; normalize and reject ambiguous identity", () => {
  const r = {
    name: "Alice",
    email: " ALICE@Example.fr ",
    role: "RSO",
    company: "Entreprise extérieure",
  };
  assert.deepEqual(normalizeRecipients([r])[0], {
    ...r,
    email: "alice@example.fr",
  });
  assert.throws(() =>
    normalizeRecipients([r, { ...r, email: "alice@example.fr" }]),
  );
  assert.throws(() => normalizeRecipients([{ ...r, role: "" }]));
  const many = Array.from({ length: 1000 }, (_, i) => ({
    ...r,
    email: `agent${i}@example.fr`,
  }));
  assert.equal(batches(normalizeRecipients(many)).length, 25);
  assert.ok(batches(many).every((b) => b.length <= 40));
});
test("40 acknowledgements append eight annex pages, each assigned to the right signer", async () => {
  const original = await lib.PDFDocument.create();
  original.addPage([595, 842]);
  const bytes = await original.save(),
    copy = bytes.slice();
  const signers = Array.from({ length: 40 }, (_, i) => ({
    id: crypto.randomUUID(),
    name: `Agent ${i}`,
    email: `a${i}@example.fr`,
    role: "RSO",
    company: "Externe",
  }));
  const result = await buildEnvelope(
    bytes,
    signers,
    {
      mode: "acknowledgement",
      title: "ISF",
      label: "B",
      sha256: "a".repeat(64),
      campaignId: crypto.randomUUID(),
    },
    lib,
  );
  assert.deepEqual(bytes, copy, "raw source is not modified");
  assert.equal(result.pages, 9);
  assert.equal(result.annexStart, 1);
  assert.equal(result.fields.length, 40);
  assert.ok(
    result.fields.every(
      (f, i) =>
        f.signer_id === signers[i].id && f.page === 2 + Math.floor(i / 5),
    ),
  );
  validateFields(result.fields, result.pages, signers);
});
test("application envelope has no invented signature positions", async () => {
  const pdf = await lib.PDFDocument.create();
  pdf.addPage();
  const result = await buildEnvelope(
    await pdf.save(),
    [],
    { mode: "application" },
    lib,
  );
  assert.equal(result.pages, 1);
  assert.deepEqual(result.fields, []);
});
