/**
 * Local stand-in for the LINE Messaging API.
 * Playwright points LINE_API_ORIGIN here. The access token is checked and never stored.
 */
import { createServer } from "node:http";

const PORT = 4601;
const TOKEN = "e2e-line-token";

/** @type {{ to: string, text: string, hasAuth: boolean }[]} */
const pushes = [];
/** @type {{ replyToken: string, text: string, hasAuth: boolean }[]} */
const replies = [];

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    pushes.length = 0;
    replies.length = 0;
    send(res, 200, {});
    return;
  }
  if (req.method === "GET" && url.pathname === "/pushes") {
    send(res, 200, { pushes, replies });
    return;
  }

  const push = req.method === "POST" && url.pathname === "/v2/bot/message/push";
  const reply = req.method === "POST" && url.pathname === "/v2/bot/message/reply";
  if (!push && !reply) {
    send(res, 404, { message: "not found" });
    return;
  }
  const hasAuth = req.headers.authorization === `Bearer ${TOKEN}`;
  if (!hasAuth) {
    send(res, 401, { message: "unauthorized" });
    return;
  }
  const raw = await readBody(req);
  const body = JSON.parse(raw.toString("utf8"));
  const text = body.messages?.[0]?.text ?? "";
  if (push) pushes.push({ to: String(body.to ?? ""), text, hasAuth: true });
  else replies.push({ replyToken: String(body.replyToken ?? ""), text, hasAuth: true });
  const id = push ? `push-${pushes.length}` : `reply-${replies.length}`;
  send(res, 200, {}, { "x-line-request-id": id });
});

server.listen(PORT, "127.0.0.1");
