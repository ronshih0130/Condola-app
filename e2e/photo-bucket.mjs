/**
 * Local stand-in for the Supabase Storage API used by ticket photo uploads.
 * Playwright points SUPABASE_URL here so the browser uploads to a bucket
 * and the Worker only signs and confirms. Bytes are not written to Postgres.
 */
import { createServer } from "node:http";
import pg from "pg";

const PORT = 4599;
const KEY = "e2e-photo-key";
const BUCKET = "ticket-photos-private";

/** @type {Map<string, { bytes: Buffer, type: string }>} */
const objects = new Map();
/** @type {Map<string, string>} */
const grants = new Map();
/** Captured GoTrue signup bodies for the consent spec. Passwords stay in memory only. */
const signups = [];
/** Captured admin user updates. Passwords are stripped before they are stored. */
const adminUpdates = [];

function databaseUrl() {
  return process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";
}

function signupMetadata(body) {
  return body.data && typeof body.data === "object" ? body.data : {};
}

async function insertSignupUser(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const metadata = signupMetadata(body);
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const existing = await client.query(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    if (existing.rows[0]) {
      return { status: 422, payload: { msg: "User already registered", error_code: "user_already_exists" } };
    }
    const inserted = await client.query(
      `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, role, aud)
       VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), $3::jsonb, 'authenticated', 'authenticated')
       RETURNING id::text AS id`,
      [email, password, JSON.stringify(metadata)],
    );
    return {
      status: 200,
      payload: { id: inserted.rows[0].id, aud: "authenticated", email, email_confirmed_at: null },
    };
  } finally {
    await client.end();
  }
}

/** Mirrors GoTrue admin generate_link type=signup: create or rotate, never send mail. */
async function generateSignupLink(body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (String(body.type || "") !== "signup") {
    return { status: 400, payload: { error_code: "validation_failed", msg: "Invalid email action link type" } };
  }
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const existing = await client.query(
      `SELECT id::text AS id, email_confirmed_at FROM auth.users WHERE lower(email) = lower($1)`,
      [email],
    );
    const row = existing.rows[0];
    if (row?.email_confirmed_at) {
      return {
        status: 422,
        payload: { error_code: "email_exists", msg: "A user with this email address has already been registered" },
      };
    }
    if (!row && !body.password) {
      return { status: 400, payload: { error_code: "validation_failed", msg: "Signup requires a valid password" } };
    }
    const id = row
      ? row.id
      : (
          await client.query(
            `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, role, aud)
             VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), $3::jsonb, 'authenticated', 'authenticated')
             RETURNING id::text AS id`,
            [email, String(body.password || ""), JSON.stringify(signupMetadata(body))],
          )
        ).rows[0].id;
    return {
      status: 200,
      payload: {
        id,
        aud: "authenticated",
        email,
        email_confirmed_at: null,
        hashed_token: `e2e-${id}`,
        verification_type: "signup",
      },
    };
  } finally {
    await client.end();
  }
}

function withoutPassword(body) {
  const copy = { ...body };
  delete copy.password;
  return copy;
}

async function updateAdminUser(userId, body) {
  const app = body.app_metadata && typeof body.app_metadata === "object" ? JSON.stringify(body.app_metadata) : null;
  const user = body.user_metadata && typeof body.user_metadata === "object" ? JSON.stringify(body.user_metadata) : null;
  const password = typeof body.password === "string" ? body.password : null;
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : null;
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const updated = await client.query(
      `UPDATE auth.users
          SET raw_app_meta_data = CASE WHEN $2::jsonb IS NULL THEN raw_app_meta_data
                                       ELSE coalesce(raw_app_meta_data, '{}'::jsonb) || $2::jsonb END,
              raw_user_meta_data = CASE WHEN $3::jsonb IS NULL THEN raw_user_meta_data
                                        ELSE coalesce(raw_user_meta_data, '{}'::jsonb) || $3::jsonb END,
              encrypted_password = CASE WHEN $4::text IS NULL THEN encrypted_password ELSE crypt($4, gen_salt('bf')) END,
              email = coalesce($5, email),
              email_confirmed_at = CASE WHEN $5::text IS NULL THEN email_confirmed_at ELSE coalesce(email_confirmed_at, now()) END,
              updated_at = now()
        WHERE id = $1
        RETURNING id::text AS id`,
      [userId, app, user, password, email],
    );
    if (!updated.rows[0]) return { status: 404, payload: { message: "user not found" } };
    return { status: 200, payload: { id: updated.rows[0].id } };
  } finally {
    await client.end();
  }
}

/** Minimal GoTrue admin/password endpoints for the local Postgres stub. */
async function inviteAuth(pathname, body, userId) {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (pathname.startsWith("/auth/v1/admin/users")) {
      if (!email || !password || body.email_confirm !== true) {
        return { status: 400, payload: { error_code: "validation_failed" } };
      }
      if (userId) {
        const updated = await client.query(
          `UPDATE auth.users SET email = $2, encrypted_password = crypt($3, gen_salt('bf')),
                  email_confirmed_at = now(), updated_at = now()
            WHERE id = $1 RETURNING id::text, email`,
          [userId, email, password],
        );
        return updated.rows[0]
          ? { status: 200, payload: updated.rows[0] }
          : { status: 404, payload: { error_code: "user_not_found" } };
      }
      const existing = await client.query(`SELECT id FROM auth.users WHERE lower(email) = lower($1)`, [email]);
      if (existing.rows[0]) return { status: 422, payload: { error_code: "email_exists" } };
      const created = await client.query(
        `INSERT INTO auth.users
           (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
         VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), '{}'::jsonb,
                 'authenticated', 'authenticated')
         RETURNING id::text, email`,
        [email, password],
      );
      return { status: 200, payload: created.rows[0] };
    }
    const account = await client.query(
      `SELECT id::text, email, email_confirmed_at FROM auth.users
        WHERE lower(email) = lower($1) AND encrypted_password = crypt($2, encrypted_password)`,
      [email, password],
    );
    const user = account.rows[0];
    if (!user) return { status: 400, payload: { error_code: "invalid_credentials" } };
    if (!user.email_confirmed_at) return { status: 400, payload: { error_code: "email_not_confirmed" } };
    return { status: 200, payload: { user } };
  } finally {
    await client.end();
  }
}

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
  if (url.pathname === "/e2e/signups" && req.method === "GET") {
    send(res, 200, JSON.stringify(signups), { "content-type": "application/json" });
    return;
  }
  if (url.pathname === "/e2e/signups" && req.method === "DELETE") {
    signups.length = 0;
    send(res, 200, "[]", { "content-type": "application/json" });
    return;
  }
  if (url.pathname === "/e2e/admin-users" && req.method === "GET") {
    send(res, 200, JSON.stringify(adminUpdates), { "content-type": "application/json" });
    return;
  }
  if (url.pathname === "/e2e/admin-users" && req.method === "DELETE") {
    adminUpdates.length = 0;
    send(res, 200, "[]", { "content-type": "application/json" });
    return;
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
  if (adminUser && req.method === "PUT") {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    adminUpdates.push({ id: decodeURIComponent(adminUser[1]), body: withoutPassword(body) });
    try {
      const result = await updateAdminUser(decodeURIComponent(adminUser[1]), body);
      send(res, result.status, JSON.stringify(result.payload), { "content-type": "application/json" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "admin update failed";
      send(res, 500, JSON.stringify({ message }), { "content-type": "application/json" });
    }
    return;
  }
  if (url.pathname === "/auth/v1/signup" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    signups.push(body);
    try {
      const result = await insertSignupUser(body);
      send(res, result.status, JSON.stringify(result.payload), { "content-type": "application/json" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "signup failed";
      send(res, 500, JSON.stringify({ message }), { "content-type": "application/json" });
    }
    return;
  }
  const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/i);
  const adminCreate = req.method === "POST" && url.pathname === "/auth/v1/admin/users";
  const adminUpdate = req.method === "PUT" && adminUser;
  const passwordGrant = req.method === "POST" && url.pathname === "/auth/v1/token" &&
    url.searchParams.get("grant_type") === "password";
  if (adminCreate || adminUpdate || passwordGrant) {
    if ((adminCreate || adminUpdate) && !authorized(req)) return send(res, 401, "unauthorized");
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const result = await inviteAuth(url.pathname, body, adminUpdate ? adminUser[1] : null);
      send(res, result.status, JSON.stringify(result.payload), { "content-type": "application/json" });
    } catch {
      send(res, 500, JSON.stringify({ message: "auth failed" }), { "content-type": "application/json" });
    }
    return;
  }
  if (url.pathname === "/auth/v1/admin/generate_link" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (body.type === "signup") signups.push(body);
    try {
      const result = await generateSignupLink(body);
      send(res, result.status, JSON.stringify(result.payload), { "content-type": "application/json" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "generate_link failed";
      send(res, 500, JSON.stringify({ message }), { "content-type": "application/json" });
    }
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
