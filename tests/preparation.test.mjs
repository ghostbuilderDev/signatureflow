import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("src/main.js", "utf8");
function setup(kind = "signature", serverError = null) {
  const calls = [],
    nodes = new Map();
  const makeNode = () => ({
    checked: true,
    hidden: true,
    children: [],
    textContent: "",
    replaceChildren(...children) {
      this.children = children;
    },
    append(child) {
      this.children.push(child);
    },
    scrollIntoView() {},
    classList: { add() {}, remove() {} },
  });
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  const S = {
    doc: { id: "doc", status: "draft" },
    signers: [{ id: "yoann", name: "Yoann PETIT" }],
    fields: [
      {
        id: "zone",
        signer_id: "yoann",
        kind,
        page: 33,
        height: 0.04,
        confirmed: true,
      },
    ],
    selected: "zone",
  };
  const ctx = vm.createContext({
    S,
    $,
    document: {
      createElement: makeNode,
      createTextNode: (text) => ({ textContent: text }),
    },
    kinds: {
      signature: "Signature",
      date: "Date de signature",
      initials: "Paraphe",
    },
    bounded: (f) => f,
    dirty: () => {
      $("#confirmPreparation").checked = false;
    },
    goPage() {},
    drawFields() {},
    notify() {},
    editable: () => S.doc.status === "draft",
    check: (r) => {
      if (r.error) throw r.error;
      return r.data;
    },
    supabase: {
      rpc: async (name, body) => {
        calls.push({ name, body });
        return { data: name.includes("confirm") ? "prepared" : null };
      },
    },
    APP_URL: "https://example.invalid/",
    invoke: async (name, body) => {
      calls.push({ name, body });
      if (serverError) throw new Error(serverError);
      return {
        links: [
          { name: "Yoann PETIT", url: "https://example.invalid/#sign=test" },
        ],
      };
    },
    openDocument: async () => {
      S.doc.status = "in_progress";
    },
    renderLinks: () => calls.push({ name: "renderLinks" }),
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function preparationError("),
      source.indexOf("function renderLinks("),
    ),
    ctx,
  );
  return { ctx, S, $, calls };
}

test("date-only validation identifies the exact signatory and field without contacting the server", () => {
  const { ctx, calls } = setup("date");
  assert.throws(
    () => vm.runInContext("validateDraft()", ctx),
    (e) => {
      assert.match(e.message, /zone de signature.*Yoann PETIT/);
      assert.equal(e.fieldId, "zone");
      assert.equal(e.signerId, "yoann");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});
test("explicit date conversion preserves attribution and requires a fresh final review", () => {
  const { ctx, S, $ } = setup("date");
  vm.runInContext(
    "try { validateDraft(); } catch(e) { showPreparationError(e); }",
    ctx,
  );
  const convert = $("#preparationFeedback").children.find((n) =>
    /Transformer/.test(n.textContent),
  );
  assert.ok(convert);
  convert.onclick();
  assert.equal(S.fields[0].kind, "signature");
  assert.equal(S.fields[0].signer_id, "yoann");
  assert.equal(S.fields[0].page, 33);
  assert.equal($("#confirmPreparation").checked, false);
  vm.runInContext("validateDraft()", ctx);
});
test("valid signature saves fields, confirms preparation and requests links in order", async () => {
  const { ctx, S, calls } = setup();
  await vm.runInContext('issueLinks("links")', ctx);
  assert.deepEqual(
    calls.map((c) => c.name),
    [
      "signatureflow_save_fields",
      "signatureflow_confirm_preparation",
      "signatureflow-invite-signer",
      "renderLinks",
    ],
  );
  assert.equal(calls[0].body.p_fields[0].kind, "signature");
  assert.equal(calls[2].body.delivery, "links");
  assert.equal(S.doc.status, "in_progress");
});
test("unchecked review blocks issuance before writing or generating links", async () => {
  const { ctx, $, calls } = setup();
  $("#confirmPreparation").checked = false;
  await assert.rejects(
    vm.runInContext('issueLinks("links")', ctx),
    /Confirmez/,
  );
  assert.equal(calls.length, 0);
});
test("server failure is surfaced without claiming links were created", async () => {
  const { ctx, S, calls, $ } = setup("signature", "Création indisponible");
  await assert.rejects(
    vm.runInContext('issueLinks("links")', ctx),
    /Création indisponible/,
  );
  assert.equal(S.doc.status, "draft");
  assert.ok(!calls.some((c) => c.name === "renderLinks"));
  vm.runInContext(
    'showPreparationError(new Error("Création indisponible"))',
    ctx,
  );
  assert.equal(
    $("#preparationFeedback").children[0].textContent,
    "Création indisponible",
  );
});
