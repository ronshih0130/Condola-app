import { createCapturedLineTransport } from "@/server/line/transport";
import { createWebhookPost } from "@/server/line/webhook";

import { resolveLocalLineSecret } from "@/server/line/secrets";

// Secrets are read lazily by reference; transport remains local capture only.
export const POST = createWebhookPost({
  resolveSecret: resolveLocalLineSecret,
  transport: createCapturedLineTransport({ mode: "accepted" }),
});
