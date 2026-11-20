import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { sha256Bytes } from "../supabase/functions/_shared/common.ts";
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const originalFetch = globalThis.fetch,
  originalServe = Deno.serve;
const owner = "00000000-0000-4000-8000-000000000001",
  documentId = "10000000-0000-4000-8000-000000000001",
  signerId = "20000000-0000-4000-8000-000000000001",
  token = "a".repeat(64);
const pdf = await PDFDocument.create();
pdf.addPage([595, 842]);
const source = await pdf.save(),
  sourceHash = await sha256Bytes(source);
const doc = {
  id: documentId,
  name: "Briefing <chantier>",
  owner_id: owner,
  status: "in_progress",
  current_storage_path: "original.pdf",
  current_sha256: sourceHash,
  revision: 1,
  signing_mode: "parallel",
  page_count: 1,
  workflow_type: "approval",
  completion_mode: "manual",
  completion_recipients: [],
  require_full_read: true,
  identity_stamp: true,
};
const signer = {
  id: signerId,
  document_id: documentId,
  name: "Alice <Dupont>",
  email: "alice@example.fr",
  status: "pending",
  token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  signing_order: 1,
  role: "Responsable travaux",
};
const fields = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    document_id: documentId,
    signer_id: signerId,
    page: 1,
    x: 0.1,
    y: 0.6,
    width: 0.3,
    height: 0.1,
    kind: "signature",
    required: true,
  },
];
const handlers = new Map<string, (req: Request) => Promise<Response>>();
let handler: (req: Request) => Promise<Response>;
Deno.serve = ((fn: unknown) => {
  handler = fn as typeof handler;
  return {};
}) as typeof Deno.serve;
Deno.env.set("SUPABASE_URL", "https://test.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only-not-a-secret");
Deno.env.set("RESEND_API_KEY", "test-resend");
Deno.env.set("SIGNATUREFLOW_EMAIL_FROM", "SignatureFlow <test@example.fr>");
Deno.env.set("SIGNATUREFLOW_APP_URL", "https://example.fr/signatureflow/");
for (const name of [
  "invite-signer",
  "get-signing-context",
  "submit-signature",
]) {
  await import(`../supabase/functions/signatureflow-${name}/index.ts`);
  handlers.set(name, handler!);
}
Deno.serve = originalServe;
const call = (name: string, body: unknown, auth = false) =>
  handlers.get(name)!(
    new Request("https://test.invalid/functions/v1/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer test-owner-jwt" } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
let audit: unknown[] = [],
  uploaded: Uint8Array | null = null,
  finished = false,
  issueCount = 0,
  resendPayloads: Record<string, unknown>[] = [];
function installFetch({
  resendStatus = 200,
  alreadySigned = false,
  completionMode = "manual",
  completeAfterFinish = false,
} = {}) {
  audit = [];
  uploaded = null;
  finished = false;
  resendPayloads = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    options?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      method = options?.method || "GET",
      payload =
        options?.body &&
        (url.pathname.startsWith("/rest/") || url.hostname === "api.resend.com")
          ? JSON.parse(String(options.body))
          : null;
    const j = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname === "/auth/v1/user")
      return j({ id: owner, email: "owner@example.fr" });
    if (url.pathname === "/rest/v1/signatureflow_documents")
      return j({
        ...doc,
        completion_mode: completionMode,
        status: completeAfterFinish && finished ? "signed" : doc.status,
      });
    if (url.pathname === "/rest/v1/signatureflow_signers")
      return j(url.searchParams.has("token_hash") ? signer : [signer]);
    if (url.pathname === "/rest/v1/signatureflow_signature_fields")
      return j(fields);
    if (url.pathname === "/rest/v1/signatureflow_audit_events") {
      audit.push(payload);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === "/rest/v1/signatureflow_deliveries") {
      if (method === "GET") return j(null);
      return j(null);
    }
    if (url.pathname === "/rest/v1/rpc/signatureflow_issue") {
      issueCount++;
      assert(
        !JSON.stringify(payload).includes("#sign="),
        "raw link must not be stored in RPC",
      );
      return j(null);
    }
    if (url.pathname === "/rest/v1/rpc/signatureflow_claim")
      return j(
        alreadySigned
          ? { alreadySigned: true, sha256: "test-final-hash" }
          : {
              document: { ...doc, completion_mode: completionMode },
              signer,
              fields,
            },
      );
    if (url.pathname === "/rest/v1/rpc/signatureflow_finish") {
      assert(!!payload.p_source && !!payload.p_final, "hash chain required");
      assert(
        payload.p_source !== payload.p_final,
        "PDF must change after stamping",
      );
      finished = true;
      return j(null);
    }
    if (url.pathname === "/rest/v1/rpc/signatureflow_release") return j(null);
    if (url.pathname.startsWith("/storage/v1/object/sign/"))
      return j({
        signedURL:
          "/object/sign/signatureflow-documents/final.pdf?token=test-only",
      });
    if (url.pathname.startsWith("/storage/v1/object/") && method === "GET")
      return new Response(new Uint8Array(source).buffer, {
        headers: { "Content-Type": "application/pdf" },
      });
    if (url.pathname.startsWith("/storage/v1/object/") && method === "POST") {
      uploaded = new Uint8Array(
        await new Response(options?.body).arrayBuffer(),
      );
      return j({ Key: "signed.pdf" });
    }
    if (url.hostname === "api.resend.com") {
      resendPayloads.push(payload);
      assert(payload.html.includes("&lt;Dupont&gt;"), "recipient HTML escaped");
      assert(
        payload.html.includes("&lt;chantier&gt;"),
        "document HTML escaped",
      );
      return j({ id: "email-test" }, resendStatus);
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  }) as typeof fetch;
}
Deno.test(
  "public context returns only assigned fields and a temporary PDF URL",
  async () => {
    installFetch();
    try {
      const res = await call("get-signing-context", { token }),
        data = await res.json();
      assert(res.status === 200, JSON.stringify(data));
      assert(data.fields.length === 1, "one assigned field");
      assert(data.document.sha256 === sourceHash, "integrity hash exposed");
      assert(!("token_hash" in data.signer), "token hash remains server-side");
      assert(audit.length === 1, "open audited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "final validation automatically emails the completed named PDF",
  async () => {
    installFetch({
      completionMode: "all_after_complete",
      completeAfterFinish: true,
    });
    try {
      const png = await Deno.readFile("tests/fixtures/signature.png"),
        signatureDataUrl =
          "data:image/png;base64," + btoa(String.fromCharCode(...png));
      const response = await call("submit-signature", {
          token,
          typedName: "Alice <Dupont>",
          accepted: true,
          signatureDataUrl,
          expectedSha256: sourceHash,
          requestId: crypto.randomUUID(),
          readPages: [1],
        }),
        data = await response.json();
      assert(response.status === 200, JSON.stringify(data));
      assert(data.delivery.sent === 1, "one final copy sent");
      assert(resendPayloads.length === 1, "one provider request");
      assert(
        Array.isArray(resendPayloads[0].attachments) &&
          resendPayloads[0].attachments.length === 1,
        "signed PDF attached",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "invitation returns personal links when email fails and escapes document/name HTML",
  async () => {
    installFetch({ resendStatus: 503 });
    try {
      const response = await call(
          "invite-signer",
          { documentId, appUrl: "https://evil.invalid/", delivery: "email" },
          true,
        ),
        data = await response.json();
      assert(response.status === 200, JSON.stringify(data));
      assert(
        data.sent === 0 && data.links.length === 1,
        "link retained when mail fails",
      );
      assert(
        data.links[0].url.startsWith("https://example.fr/signatureflow/#sign="),
        "dedicated server URL takes precedence",
      );
      assert(data.links[0].error.includes("503"), "mail failure reported");
      assert(issueCount > 0, "envelope issued before sharing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "real signature submission stamps and commits a PDF with consent and hashes",
  async () => {
    installFetch();
    try {
      const png = await Deno.readFile("tests/fixtures/signature.png"),
        signatureDataUrl =
          "data:image/png;base64," + btoa(String.fromCharCode(...png));
      const response = await call("submit-signature", {
          token,
          typedName: "Alice <Dupont>",
          accepted: true,
          signatureDataUrl,
          expectedSha256: sourceHash,
          requestId: crypto.randomUUID(),
          readPages: [1],
        }),
        data = await response.json();
      assert(response.status === 200, JSON.stringify(data));
      assert(data.ok && finished, "transaction committed");
      assert(!!uploaded, "PDF uploaded");
      assert(
        (await PDFDocument.load(uploaded!)).getPageCount() === 1,
        "valid PDF preserved",
      );
      assert(data.sha256 !== sourceHash, "signed hash changed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "public endpoints reject malformed tokens and consent cannot be omitted",
  async () => {
    installFetch();
    try {
      assert(
        (await call("get-signing-context", { token: "bad" })).status === 404,
        "bad token rejected",
      );
      const response = await call("submit-signature", {
        token,
        typedName: "Alice",
        accepted: false,
        requestId: crypto.randomUUID(),
        expectedSha256: sourceHash,
      });
      assert(response.status === 400, "consent checked on server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
