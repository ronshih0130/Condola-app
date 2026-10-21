/**
 * Local stand-in for the Supabase Storage API used by ticket photo uploads.
 * Playwright points SUPABASE_URL here so the browser uploads to a bucket
 * and the Worker only signs and confirms. Bytes are not written to Postgres.
 */
import { createServer } from "node:http";

const PORT = 4599;
const KEY = "e2e-photo-key";
const BUCKET = "ticket-photos-private";

/** @type {Map<string, { bytes: Buffer, type: string }>} */
const objects = new Map();
/** @type {Map<string, string>} */
const grants = new Map();

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,apikey,range,cache-control",
    "access-control-expose-headers": "content-type,content-range,content-length",
    ...headers,
  });
  res.end(body);
}

function authorized(req) {
  const auth = req.headers.authorization || "";
  const api = req.headers.apikey || "";
  return auth === `Bearer ${KEY}` || api === KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decodePath(raw) {
  return raw.split("/").map((part) => decodeURIComponent(part)).join("/");
}

function encodePath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, "ok", { "content-type": "text/plain" });
    return;
  }

  const uploadSign = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/);
  if (uploadSign && req.method === "POST") {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    const bucket = decodeURIComponent(uploadSign[1]);
    const path = decodePath(uploadSign[2]);
    if (bucket !== BUCKET) return send(res, 404, "bucket");
    const token = `up-${grants.size + 1}`;
    grants.set(token, path);
    const signedPath = `/object/upload/sign/${bucket}/${encodePath(path)}?token=${token}`;
    send(res, 200, JSON.stringify({ url: signedPath, token }), { "content-type": "application/json" });
    return;
  }
  if (uploadSign && req.method === "PUT") {
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
    const token = url.searchParams.get("token") || bearer;
    const path = grants.get(token);
    if (!path) return send(res, 403, "bad token");
    const bytes = await readBody(req);
    objects.set(path, { bytes, type: String(req.headers["content-type"] || "application/octet-stream") });
    send(res, 200, JSON.stringify({ Key: path }), { "content-type": "application/json" });
    return;
  }

  const info = url.pathname.match(/^\/storage\/v1\/object\/info\/([^/]+)\/(.+)$/);
  if (info && req.method === "GET") {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    const object = objects.get(decodePath(info[2]));
    if (!object) return send(res, 404, "missing");
    send(
      res,
      200,
      JSON.stringify({ size: object.bytes.length, contentType: object.type, metadata: { mimetype: object.type } }),
      { "content-type": "application/json" },
    );
    return;
  }

  const sign = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)$/);
  if (sign && req.method === "POST") {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const rows = [];
    for (const path of body.paths || []) {
      if (!objects.has(path)) continue;
      rows.push({ path, signedURL: `/object/sign/${sign[1]}/${encodePath(path)}?token=read` });
    }
    send(res, 200, JSON.stringify(rows), { "content-type": "application/json" });
    return;
  }

  const readSigned = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (readSigned && req.method === "GET") {
    const object = objects.get(decodePath(readSigned[2]));
    if (!object || url.searchParams.get("token") !== "read") return send(res, 404, "missing");
    send(res, 200, object.bytes, {
      "content-type": object.type,
      "content-length": String(object.bytes.length),
      "cache-control": "private, max-age=600",
    });
    return;
  }

  const objectRoute = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (objectRoute && req.method === "GET") {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    const object = objects.get(decodePath(objectRoute[2]));
    if (!object) return send(res, 404, "missing");
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ""));
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), Math.max(object.bytes.length - 1, 0));
      const slice = object.bytes.subarray(start, end + 1);
      send(res, 206, slice, {
        "content-type": object.type,
        "content-range": `bytes ${start}-${end}/${object.bytes.length}`,
        "content-length": String(slice.length),
      });
      return;
    }
    send(res, 200, object.bytes, { "content-type": object.type, "content-length": String(object.bytes.length) });
    return;
  }
  if (objectRoute && req.method === "DELETE") {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    objects.delete(decodePath(objectRoute[2]));
    send(res, 200, "{}", { "content-type": "application/json" });
    return;
  }

  send(res, 404, `no route ${req.method} ${url.pathname}`, { "content-type": "text/plain" });
});

server.listen(PORT, "127.0.0.1");
