import {
  encryptLink,
  decryptLink,
  verifySvix,
  verifyJobSecret,
} from "../supabase/functions/_shared/flow-security.ts";
function assert(value: unknown, message = "Assertion failed") {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected rejection");
}
Deno.test(
  "personal links encrypted with random IV and authenticated ciphertext",
  async () => {
    Deno.env.set("SIGNATUREFLOW_FLOW_KEY", "e".repeat(64));
    const link = "https://example.fr/#sign=" + "a".repeat(64);
    const one = await encryptLink(link),
      two = await encryptLink(link);
    assert(one !== two);
    assert(!one.includes("sign=") && !one.includes("example"));
    assert((await decryptLink(one)) === link);
    const [iv, c] = one.split(".");
    await rejects(() =>
      decryptLink(iv + "." + (c[0] === "a" ? "b" : "a") + c.slice(1)),
    );
    Deno.env.set("SIGNATUREFLOW_FLOW_KEY", "f".repeat(64));
    await rejects(() => decryptLink(one));
  },
);
Deno.test(
  "Resend raw-body verification rejects tampering, replay and unsigned events",
  async () => {
    const raw = '{"type":"email.delivered","data":{"email_id":"mail1"}}',
      id = "msg_123",
      timestamp = String(Math.floor(Date.now() / 1000));
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = "whsec_" + btoa(String.fromCharCode(...secretBytes));
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${raw}`),
    );
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature":
        "v1," + btoa(String.fromCharCode(...new Uint8Array(signed))),
    });
    assert((await verifySvix(raw, headers, secret)) === id);
    await rejects(() => verifySvix(raw + " ", headers, secret));
    await rejects(() => verifySvix(raw, headers, secret, Date.now() + 301000));
    await rejects(() => verifySvix(raw, new Headers(), secret));
  },
);
Deno.test(
  "background jobs cannot be invoked using a public anon key",
  async () => {
    Deno.env.set("SIGNATUREFLOW_JOB_TOKEN", "job-".repeat(12));
    await rejects(() =>
      verifyJobSecret(
        new Request("https://example.fr", {
          headers: { Authorization: "Bearer public-anon-key" },
        }),
      ),
    );
    await verifyJobSecret(
      new Request("https://example.fr", {
        headers: { Authorization: "Bearer " + "job-".repeat(12) },
      }),
    );
  },
);
