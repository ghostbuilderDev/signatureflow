import {
  adminClient,
  json,
  failure,
  HttpError,
  checked,
} from "../_shared/common.ts";
import { verifySvix } from "../_shared/flow-security.ts";
Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") throw new HttpError("POST requis", 405);
    const reader = req.body?.getReader();
    if (!reader) throw new HttpError("Corps requis");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 150000) {
        await reader.cancel();
        throw new HttpError("Message trop volumineux", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    const raw = new TextDecoder().decode(bytes);
    const id = await verifySvix(
      raw,
      req.headers,
      Deno.env.get("RESEND_WEBHOOK_SECRET") || "",
    );
    const event = JSON.parse(raw);
    const states: any = {
      "email.delivered": "delivered",
      "email.bounced": "bounced",
      "email.complained": "complained",
      "email.failed": "failed",
    };
    const state = states[event.type];
    if (!state) return json({ ok: true, ignored: true });
    checked(
      await adminClient().rpc("sf3_resend_event", {
        p_event_id: id,
        p_email_id: event.data?.email_id,
        p_state: state,
      }),
    );
    return json({ ok: true });
  } catch (e) {
    return failure(e);
  }
});
