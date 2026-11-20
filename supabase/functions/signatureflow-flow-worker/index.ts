import { adminClient, json, failure } from "../_shared/common.ts";
import { verifyJobSecret } from "../_shared/flow-security.ts";
import { runJobs, scheduleReminders } from "../_shared/flow-jobs.ts";
Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST")
      return new Response("POST requis", { status: 405 });
    await verifyJobSecret(req);
    const admin = adminClient();
    await scheduleReminders(admin);
    return json({ ok: true, results: await runJobs(admin, undefined, 10) });
  } catch (e) {
    return failure(e);
  }
});
