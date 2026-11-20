import { encryptLink } from "../supabase/functions/_shared/flow-security.ts";
import { runJobs } from "../supabase/functions/_shared/flow-jobs.ts";
import { adminClient } from "../supabase/functions/_shared/common.ts";
const u = "00000000-0000-4000-8000-000000000001",
  site = "00000000-0000-4000-8000-000000000002",
  doc = "10000000-0000-4000-8000-000000000001",
  vid = "10000000-0000-4000-8000-000000000002",
  cid = "20000000-0000-4000-8000-000000000001",
  eid = "20000000-0000-4000-8000-000000000002",
  sid = "20000000-0000-4000-8000-000000000003";
const assert = (v: unknown, m = "Assertion failed") => {
  if (!v) throw new Error(m);
};
Deno.env.set("SUPABASE_URL", "https://flow-test.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "server-test");
Deno.env.set("SUPABASE_ANON_KEY", "public-test");
Deno.env.set("SIGNATUREFLOW_APP_URL", "https://signature.example.fr/");
Deno.env.set("SIGNATUREFLOW_FLOW_KEY", "a".repeat(64));
Deno.env.set("RESEND_API_KEY", "resend-test");
Deno.env.set("SIGNATUREFLOW_EMAIL_FROM", "documents@example.fr");
let handler: (req: Request) => Promise<Response>;
const originalServe = Deno.serve,
  originalFetch = fetch;
Deno.serve = ((fn: unknown) => {
  handler = fn as typeof handler;
  return {};
}) as typeof Deno.serve;
await import("../supabase/functions/signatureflow-flow/index.ts");
Deno.serve = originalServe;
const cipher = await encryptLink(
  "https://signature.example.fr/#sign=" + "f".repeat(64),
);
let allowed = true,
  currentEmail = "external@example.fr",
  claimCount = 0;
let patches: any[] = [],
  mailCalls = 0;
const version = {
    id: vid,
    document_id: doc,
    label: "B",
    state: "current",
    source_path: "original.pdf",
  },
  document = {
    id: doc,
    owner_id: u,
    chantier_id: site,
    current_version_id: vid,
    title: "ISF",
    document_type: "ISF",
  },
  signer = {
    id: sid,
    document_id: eid,
    name: "Externe",
    email: "external@example.fr",
    role: "RSO",
    status: "pending",
    token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
function setup() {
  allowed = true;
  currentEmail = "external@example.fr";
  claimCount = 0;
  patches = [];
  mailCalls = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(
        typeof input === "string" ? input : input.url || String(input),
      ),
      path = url.pathname,
      method = init.method || "GET";
    const payload = init.body ? JSON.parse(init.body) : null;
    const j = (v: any, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/auth/v1/user")
      return j({
        id: u,
        email: currentEmail,
        email_confirmed_at: new Date().toISOString(),
      });
    if (path.includes("/rpc/journal_can_")) {
      assert(
        new Headers(init.headers).get("authorization") ===
          "Bearer current-user",
        "JDC rights must use the current user JWT",
      );
      return j(allowed);
    }
    if (path === "/rest/v1/rpc/sf3_claim_jobs")
      return j(
        claimCount++ === 0
          ? [
              {
                id: "job1",
                lease_id: payload.p_lease,
                kind: "invitation",
                version_id: vid,
                signer_id: sid,
                attempts: 1,
                payload: { cipher },
              },
            ]
          : [],
      );
    if (path === "/rest/v1/sf3_jobs" && method === "PATCH") {
      patches.push(payload);
      return j(null);
    }
    if (
      path === "/rest/v1/sf3_jobs" ||
      path === "/rest/v1/sf3_archives" ||
      path === "/rest/v1/sf3_events"
    )
      return j([]);
    const object = new Headers(init.headers)
      .get("accept")
      ?.includes("vnd.pgrst.object");
    const rows: any = {
      sf3_documents: document,
      sf3_versions: version,
      sf3_campaigns: {
        id: cid,
        version_id: vid,
        mode: "acknowledgement",
        copies: [],
      },
      sf3_envelopes: { envelope_id: eid, campaign_id: cid, annex_start: 1 },
      sf3_recipients: {
        signer_id: sid,
        envelope_id: eid,
        campaign_id: cid,
        link_cipher: cipher,
      },
      signatureflow_documents: {
        id: eid,
        owner_id: u,
        status: "in_progress",
        lock_id: "PRIVATE-LOCK",
        current_storage_path: "original.pdf",
      },
      signatureflow_signers: signer,
    };
    const table = path.split("/").at(-1);
    if (rows[table!]) {
      if (table === "signatureflow_signers" && url.searchParams.has("email")) {
        assert(
          url.searchParams.get("email") === "eq." + currentEmail,
          "inbox must match the verified email",
        );
        if (currentEmail !== signer.email) return j([]);
      }
      let row = { ...rows[table!] };
      if (
        table === "sf3_recipients" &&
        url.searchParams.get("select") !== "*" &&
        !url.searchParams.get("select")?.includes("link_cipher")
      )
        delete row.link_cipher;
      return j(object ? row : [row]);
    }
    if (path.startsWith("/storage/v1/object/sign/"))
      return j({ signedURL: "/object/sign/temp.pdf?token=temp" });
    if (url.hostname === "api.resend.com") {
      mailCalls++;
      assert(new Headers(init.headers).get("idempotency-key") === "sf3-job1");
      return j({ message: "Simulated provider unavailable" }, 503);
    }
    throw new Error("Unexpected " + method + " " + path);
  }) as typeof fetch;
}
async function call(action: string, values: any = {}, auth = true) {
  return handler!(
    new Request("https://flow-test.invalid/flow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer current-user" } : {}),
      },
      body: JSON.stringify({ action, ...values }),
    }),
  );
}
Deno.test(
  "management endpoints require a verified organizer session and JDC permissions",
  async () => {
    setup();
    try {
      assert((await call("list", {}, false)).status === 401);
      allowed = false;
      assert(
        (
          await call("createCampaign", {
            versionId: vid,
            mode: "acknowledgement",
          })
        ).status === 403,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "native inbox matches the verified assigned email even without JDC membership",
  async () => {
    setup();
    try {
      allowed = false;
      let response = await call("inbox");
      let result = await response.json();
      assert(response.ok && result.items.length === 1, JSON.stringify(result));
      assert(result.items[0].url.includes("#sign="));
      assert(!JSON.stringify(result).includes(cipher));
      currentEmail = "other@example.fr";
      response = await call("inbox");
      result = await response.json();
      assert(result.items.length === 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "document readers receive no processing lock or encrypted invitation secrets",
  async () => {
    setup();
    try {
      const response = await call("details", { versionId: vid }),
        result = await response.json();
      assert(response.ok, JSON.stringify(result));
      assert(!JSON.stringify(result).includes("PRIVATE-LOCK"));
      assert(!JSON.stringify(result).includes(cipher));
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
Deno.test(
  "Resend failure queues a retry and cannot undo a recorded signature",
  async () => {
    setup();
    try {
      const result = await runJobs(adminClient(), vid, 1);
      assert(result.length === 1 && !result[0].ok);
      assert(mailCalls === 1);
      assert(
        patches.some(
          (p) =>
            p.status === "error" &&
            p.available_at &&
            p.last_error.includes("unavailable"),
        ),
      );
      assert(
        !patches.some((p) => p.status === "signed" || p.status === "pending"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
