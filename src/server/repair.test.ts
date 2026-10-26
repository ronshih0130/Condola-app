import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import {
  EXPENSE_STATUSES,
  PHOTO_MAX_BYTES,
  REPAIR_EXPENSE_STATUS,
  acceptPhotoObject,
  assertPhotoMeta,
  cleanVendorName,
  completionDate,
  datesInOrder,
  expenseLinkPlan,
  isTicketPhotoPath,
  liveExpenseId,
  minorToInput,
  ticketPhotoPaths,
  parseOptionalDate,
  parseOptionalMoney,
  sniffHeic,
  sniffPhotoMime,
  tenantCancelAllowed,
  ticketPhotoPath,
} from "./repair-rules";
import { confirmTicketPhoto, discardUploadAllowed, issueUploadGrant, ticketPhotoResponse, uploadGrantMatches } from "./ticket-photos";
import type { Session } from "./types";

const root = new URL("../../", import.meta.url);

test("photo GET hides expected access failures and preserves redirects and server errors", async () => {
  for (const key of ["errors.forbidden", "errors.notFound"]) {
    const response = await ticketPhotoResponse(async () => {
      throw new FlowError(key);
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  }

  const missing = await ticketPhotoResponse(async () => null);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found");

  for (const error of [new Error("storage unavailable"), new FlowError("errors.photoStorage")]) {
    await assert.rejects(
      ticketPhotoResponse(async () => {
        throw error;
      }),
      (caught: unknown) => caught === error,
    );
  }

  const url = "https://storage.example/photo.jpg";
  const response = await ticketPhotoResponse(async () => ({ url }));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), url);
});

test("photo rules cap size and type and never describe a re-encode", () => {
  const ok = assertPhotoMeta({ fileName: "浴室.jpg", mime: "image/jpeg", size: 1200 });
  assert.equal(ok.mime, "image/jpeg");
  assert.equal(ok.size, 1200);
  for (const input of [
    { fileName: "a.jpg", mime: "image/heic", size: 100 },
    { fileName: "a.jpg", mime: "image/heif", size: 100 },
    { fileName: "a.heic", mime: "image/jpeg", size: 100 },
    { fileName: "a.HEIF", mime: "image/jpeg", size: 100 },
  ]) {
    assert.throws(() => assertPhotoMeta(input), (error: unknown) => error instanceof FlowError && error.key === "errors.photoHeic");
  }
  assert.throws(() => assertPhotoMeta({ fileName: "a.jpg", mime: "image/jpeg", size: PHOTO_MAX_BYTES + 1 }), (error: unknown) => {
    return error instanceof FlowError && error.key === "errors.photoSize";
  });
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
  const accepted = acceptPhotoObject({ size: 40, mime: "image/jpg", header: jpeg }, "image/jpeg");
  assert.deepEqual(accepted, { size: 40, mime: "image/jpeg" });
  assert.equal(sniffPhotoMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(sniffPhotoMime(webp), "image/webp");
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  for (const [header, mime] of [[jpeg, "image/jpeg"], [png, "image/png"], [webp, "image/webp"]] as const) {
    assert.deepEqual(
      acceptPhotoObject({ size: 40, mime: "application/octet-stream", header }, mime),
      { size: 40, mime },
    );
  }
  assert.equal(sniffPhotoMime(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), null);
  assert.throws(
    () => acceptPhotoObject({ size: 40, mime: "image/jpeg", header: Uint8Array.of(0x25, 0x50, 0x44, 0x46) }, "image/jpeg"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.photoType",
  );
  assert.throws(
    () => acceptPhotoObject({ size: 40, mime: "image/png", header: jpeg }, "image/jpeg"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.photoType",
  );
  assert.throws(() => assertPhotoMeta({ fileName: "a.gif", mime: "image/gif", size: 100 }), (error: unknown) => {
    return error instanceof FlowError && error.key === "errors.photoType";
  });

  const path = ticketPhotoPath(
    "10000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000003",
    "image/png",
  );
  assert.equal(
    isTicketPhotoPath(path, "10000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"),
    true,
  );
  assert.equal(isTicketPhotoPath(path, "10000000-0000-4000-8000-000000000009", "30000000-0000-4000-8000-000000000002"), false);
  assert.deepEqual(
    ticketPhotoPaths("10000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002", [
      path,
      "org/10000000-0000-4000-8000-000000000001/tickets/30000000-0000-4000-8000-000000000009/40000000-0000-4000-8000-000000000003.png",
      path,
    ]),
    [path],
  );

  const server = readFileSync(new URL("./ticket-photos.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../components/ticket-photos.tsx", import.meta.url), "utf8");
  const view = readFileSync(new URL("../components/repair-thread.tsx", import.meta.url), "utf8");
  for (const source of [server, client, view]) {
    assert.equal(source.includes("sharp"), false);
    assert.equal(source.includes("createImageBitmap"), false);
    assert.equal(source.includes("toDataURL"), false);
    assert.equal(source.includes("OffscreenCanvas"), false);
  }
  assert.match(client, /\/api\/tickets\/photos\/sign/);
  assert.match(client, /\/api\/tickets\/photos\/confirm/);
  assert.match(client, /body: file/);
  assert.doesNotMatch(client, /FormData/);
  assert.doesNotMatch(client, /\/api\/tickets\/photos"/);
  assert.match(client, /sniffPhotoMime/);
  assert.match(client, /sniffHeic/);
  assert.match(client, /body: file/);
  assert.doesNotMatch(client, /heicToJpeg/);
  assert.match(server, /ensureJpegObject/);
  assert.equal(tenantCancelAllowed("open"), true);
  assert.equal(tenantCancelAllowed("assigned"), false);
  assert.equal(tenantCancelAllowed("triaged"), false);
  const heic = new Uint8Array(12);
  heic.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  assert.equal(sniffHeic(heic), true);
  assert.equal(sniffHeic(Uint8Array.of(0xff, 0xd8, 0xff)), false);
  assert.throws(
    () => acceptPhotoObject({ size: 40, mime: "image/jpeg", header: heic }, "image/jpeg"),
    (error: unknown) => error instanceof FlowError && error.key === "errors.photoHeic",
  );
  assert.match(server, /bytes=0-/);
  assert.match(server, /AbortSignal\.timeout/);
  assert.match(server, /object\/info/);
  assert.match(server, /signTicketPhotoUrls/);
  assert.match(server, /ticketPhotoPaths/);
  assert.doesNotMatch(server, /storeTicketPhoto/);
  assert.doesNotMatch(server, /content: input\.bytes/);
  assert.doesNotMatch(client, /image\/gif/);
  assert.doesNotMatch(server, /image\/gif/);
  assert.match(view, /no-img-element/);
  assert.match(view, /\/api\/tickets\/photos\//);
  assert.match(view, /repair-photo-preview/);
  assert.doesNotMatch(view, /from "next\/image"/);
});

test("HEIC conversion failures and server rejections show the specific HEIC message", () => {
  const client = readFileSync(new URL("../components/ticket-photos.tsx", import.meta.url), "utf8");
  assert.match(client, /await heicFileToJpeg\(file\);[\s\S]*?\} catch \{\s*setError\(messages\.heic\);\s*return;\s*\}/);
  assert.doesNotMatch(client, /photoFailed\(messages,\s*[^,]+,\s*messages\.heic\)/);
  assert.match(client, /if \(key === "errors\.photoHeic"\) return messages\.heic;/);
});

test("HEIC decoding stays behind a browser event and is excluded from server bundles", () => {
  const sources = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
  const decoderImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:heic-convert(?:\/[^"']*)?|heic-decode(?:\/[^"']*)?|libheif-js(?:\/[^"']*)?|\.\/heic-jpeg)["']/;
  for (const dir of ["src/server/", "src/app/"]) {
    for (const path of sources(new URL(dir, root))) {
      assert.doesNotMatch(readFileSync(path, "utf8"), decoderImport, path.pathname);
    }
  }
  assert.equal(existsSync(new URL("./heic-jpeg.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./heic-convert.d.ts", import.meta.url)), false);
  for (const path of sources(new URL("src/", root))) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /(?:\bfrom\s*|\bimport\s*|\bimport\s+\w+\s*=\s*require\s*\(\s*)["']heic-convert(?:\/[^"']*)?["']/,
      path.pathname,
    );
  }
  const browser = readFileSync(new URL("src/lib/heic-browser.ts", root), "utf8");
  assert.match(browser, /async function heicFileToJpeg\(file: File\): Promise<File>/);
  assert.match(browser, /await import\("heic-convert\/browser"\)/);
  assert.match(browser, /sniffPhotoMime/);
  assert.match(browser, /PHOTO_MAX_BYTES/);
  const client = readFileSync(new URL("src/components/ticket-photos.tsx", root), "utf8");
  assert.doesNotMatch(client, /heicToJpeg/);
  assert.match(client, /sniffHeic/);
  assert.match(client, /async function onChange[\s\S]*await heicFileToJpeg\(file\)/);
  assert.doesNotMatch(client, /"content-type":\s*heic/);
  const config = readFileSync(new URL("next.config.ts", root), "utf8");
  assert.match(config, /webpack:\s*\(config,\s*\{\s*isServer\s*\}\)/);
  for (const name of ["heic-convert", "heic-convert/browser", "heic-decode", "libheif-js"]) {
    assert.ok(
      config.includes(`"${name}": false`),
      `${name} must be excluded from server bundles`,
    );
  }
  assert.match(config, /if \(isServer\)\s*\{\s*config\.resolve\.alias\s*=\s*\{[^}]*"heic-convert": false[^}]*"heic-convert\/browser": false[^}]*"heic-decode": false[^}]*"libheif-js": false/);
  const vendor = readFileSync(new URL("./vendor-repair.ts", import.meta.url), "utf8");
  assert.match(vendor, /const DISCARD = new Set\(\[[^\]]*"errors\.photoHeic"/);
});

test("dates, money, vendor, and the expense link stay optional", () => {
  assert.equal(parseOptionalDate(""), null);
  assert.equal(parseOptionalDate("2026-11-12"), "2026-11-12");
  assert.throws(() => parseOptionalDate("2026-02-31"), (error: unknown) => error instanceof FlowError && error.key === "errors.date");
  assert.throws(() => datesInOrder("2026-11-12", "2026-11-01"), (error: unknown) => error instanceof FlowError && error.key === "errors.date");
  assert.equal(parseOptionalMoney(""), null);
  assert.equal(parseOptionalMoney("1800"), 180000);
  assert.equal(minorToInput("180000"), "1800");
  assert.equal(cleanVendorName("  老張水電  "), "老張水電");
  assert.equal(cleanVendorName("   "), null);
  assert.equal(completionDate("resolved", null, "2026-11-12"), "2026-11-12");
  assert.equal(completionDate("open", null, "2026-11-12"), null);
  assert.equal(completionDate("closed", "2026-11-02", "2026-11-12"), "2026-11-02");

  assert.equal(liveExpenseId(null), null);
  assert.equal(liveExpenseId({ id: "exp", status: "void" }), null);
  assert.equal(liveExpenseId({ id: "exp", status: "draft" }), "exp");
  assert.equal(liveExpenseId({ id: "exp", status: "posted" }), "exp");
  assert.equal(expenseLinkPlan({ post: false, finalMinor: 100, expenseId: null, canPost: true }), "skip");
  assert.equal(expenseLinkPlan({ post: true, finalMinor: null, expenseId: "exp", canPost: true }), "keep");
  assert.equal(expenseLinkPlan({ post: true, finalMinor: 100, expenseId: null, canPost: true }), "create");
  assert.throws(
    () => expenseLinkPlan({ post: true, finalMinor: 100, expenseId: null, canPost: false }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  assert.throws(
    () => expenseLinkPlan({ post: true, finalMinor: 0, expenseId: null, canPost: true }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.amount",
  );
});

test("the repair migration follows 20261023090000 and posts only a draft link", () => {
  const names = readdirSync(new URL("supabase/migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
  const repair = names.find((name) => name.includes("repair_records"));
  assert.equal(repair, "20261023150000_repair_records.sql");
  assert.ok(repair > "20261023090000");
  assert.deepEqual(
    names.filter((name) => name.startsWith("20261023120000")),
    [],
  );
  const bulk = names.find((name) => name.includes("bulk_import"));
  assert.equal(bulk, "20261026130000_bulk_import.sql");
  assert.ok(bulk && bulk > "20261026120000_email_log.sql");
  assert.ok(names.includes("20261023090000_lease_deposit_override_check.sql"));
  const sql = readFileSync(new URL(`supabase/migrations/${repair}`, root), "utf8");
  assert.match(sql, /^-- Version 20261023150000\./);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
  assert.match(sql, /tenant_owns_ticket/);
  assert.match(sql, /ticket-photos-private/);
  assert.match(sql, /file_size_limit/);
  assert.match(sql, /5242880/);
  assert.match(sql, /expense_id uuid/);
  assert.match(sql, /expenses_one_draft_ticket_idx/);
  assert.match(sql, /status = 'draft'/);
  assert.match(sql, /DROP INDEX IF EXISTS expenses_one_live_ticket_idx/);
  assert.match(sql, /files_ticket_photo_path/);
  assert.match(sql, /fn_ticket_photo_attachment/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /portal_ticket_photo_read/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS content bytea/);
  assert.match(sql, /COMMENT ON COLUMN ticket_attachments\.content/);
  assert.match(sql, /Do not write this column/);
  assert.match(sql, /ticket_attachments_photo_bytes/);
  assert.doesNotMatch(sql, /DROP COLUMN/);
  assert.match(sql, /count\(\*\)/);
  assert.doesNotMatch(sql, /is_internal[\s\S]{0,80}ticket photo limit/);
  assert.doesNotMatch(sql, /expense_id uuid NOT NULL/);
  assert.match(sql, /"public" = false/);
  assert.doesNotMatch(sql, /image\/gif/);
  assert.doesNotMatch(sql, /INSERT INTO ledger/);

  assert.equal(REPAIR_EXPENSE_STATUS, "draft");
  assert.deepEqual([...EXPENSE_STATUSES], ["draft", "submitted", "approved", "rejected", "posted", "void"]);
  const schema = readFileSync(new URL("supabase/migrations/20261018120000_schema.sql", root), "utf8");
  assert.match(schema, /CREATE TYPE expense_status\s+AS ENUM \('draft','submitted','approved','rejected','posted','void'\)/);

  const repairs = readFileSync(new URL("./repairs.ts", import.meta.url), "utf8");
  assert.match(repairs, /liveExpenseId/);
  assert.match(repairs, /FOR UPDATE/);
  assert.match(repairs, /REPAIR_EXPENSE_STATUS/);
  assert.match(repairs, /::expense_status/);
  assert.match(repairs, /ticket_id/);
  assert.doesNotMatch(repairs, /'(submitted|approved|posted|rejected)'/);
  assert.doesNotMatch(repairs, /ledger_transactions/);
  assert.match(repairs, /does not write/);
  assert.doesNotMatch(repairs, /INSERT INTO ticket_attachments \([^)]*content/);
  const photoRoute = readFileSync(new URL("../app/api/tickets/photos/[id]/route.ts", import.meta.url), "utf8");
  assert.match(photoRoute, /return ticketPhotoResponse\(\(\) => openTicketPhoto\(session, id\)\)/);
  assert.doesNotMatch(photoRoute, /photo\.bytes/);
  assert.equal(existsSync(new URL("../app/api/tickets/photos/route.ts", import.meta.url)), false);
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  const expenses = readFileSync(new URL("./expenses.ts", import.meta.url), "utf8");
  assert.match(domain, /STATEMENT_EXPENSE_SQL/);
  assert.match(expenses, /status IN \('approved','posted'\)/);
  assert.match(expenses, /u\.label \|\| ' · ' \|\| rm\.label/);
  assert.match(expenses, /LEFT JOIN rooms rm ON rm\.id = t\.room_id/);
  const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  assert.match(queries, /\$3::uuid IS NULL OR t\.unit_id = \$3/);
  assert.match(queries, /\$4::uuid IS NULL OR t\.room_id = \$4/);

  const page = readFileSync(new URL("../app/m/tickets/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /expense_id && ticket\.expense_status !== "void"/);
  assert.match(page, /data-testid="repair-post-expense"/);
});

test("confirm returns an attached photo and deletes only an unattached upload issued to this caller", async () => {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "repair-grant-test-key";
  const org = "10000000-0000-4000-8000-000000000001";
  const ticketId = "30000000-0000-4000-8000-000000000002";
  const path = ticketPhotoPath(org, ticketId, "40000000-0000-4000-8000-000000000003", "image/jpeg");
  const userId = "20000000-0000-4000-8000-000000000004";
  const session: Session = {
    userId,
    sessionId: "repair-confirm",
    email: "tenant@demo",
    name: "租客",
    kind: "tenant",
    role: null,
    orgId: org,
    liveOrgId: org,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
  const target = async () => ({ org_id: org, count: "1" });
  try {
    assert.equal(discardUploadAllowed("att", true), false);
    assert.equal(discardUploadAllowed("att", false), false);
    assert.equal(discardUploadAllowed(null, false), false);
    assert.equal(discardUploadAllowed(null, true), true);
    const token = issueUploadGrant(userId, ticketId, path);
    assert.equal(uploadGrantMatches(userId, ticketId, path, token), true);
    assert.equal(uploadGrantMatches(userId, ticketId, path, "not-issued"), false);
    assert.equal(uploadGrantMatches("20000000-0000-4000-8000-000000000099", ticketId, path, token), false);
    const other = ticketPhotoPath(org, ticketId, "40000000-0000-4000-8000-000000000009", "image/jpeg");
    assert.equal(uploadGrantMatches(userId, ticketId, other, token), false);

    const removed: string[] = [];
    const remove = async (stored: string) => {
      removed.push(stored);
    };
    const kept = await confirmTicketPhoto(
      session,
      { ticketId, path, fileName: "wrong.png", mime: "image/png", size: 12, internal: false, uploadToken: token },
      {
        target,
        existing: async () => "att",
        remove,
        info: async () => {
          throw new Error("storage");
        },
        header: async () => {
          throw new Error("storage");
        },
      },
    );
    assert.equal(kept, "att");
    assert.deepEqual(removed, []);

    await assert.rejects(
      confirmTicketPhoto(
        session,
        { ticketId, path, fileName: "wrong.png", mime: "image/png", size: 12, internal: false, uploadToken: "not-issued" },
        { target, existing: async () => null, remove },
      ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );
    assert.deepEqual(removed, []);

    await assert.rejects(
      confirmTicketPhoto(
        session,
        { ticketId, path, fileName: "a.jpg", mime: "image/jpeg", size: 40, internal: false, uploadToken: token },
        {
          target,
          existing: async () => null,
          info: async () => ({ ok: true, size: 40, mime: "image/jpeg" }),
          header: async () => Uint8Array.of(0x25, 0x50, 0x44, 0x46),
          remove,
        },
      ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.photoType",
    );
    assert.deepEqual(removed, [path]);

    removed.length = 0;
    await assert.rejects(
      confirmTicketPhoto(
        session,
        { ticketId, path, fileName: "a.jpg", mime: "image/jpeg", size: 40, internal: false, uploadToken: token },
        {
          target,
          existing: async () => null,
          info: async () => ({ ok: true, size: 40, mime: "image/jpeg" }),
          header: async () => Uint8Array.of(0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63),
          remove,
        },
      ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.photoHeic",
    );
    assert.deepEqual(removed, [path]);

    removed.length = 0;
    await assert.rejects(
      confirmTicketPhoto(
        session,
        { ticketId, path, fileName: "a.jpg", mime: "image/jpeg", size: 40, internal: false, uploadToken: token },
        {
          target,
          existing: async () => null,
          info: async () => ({ ok: true, size: 40, mime: "image/jpeg" }),
          header: async () => {
            throw new FlowError("errors.photoStorage");
          },
          remove,
        },
      ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.photoStorage",
    );
    assert.deepEqual(removed, [path]);

    removed.length = 0;
    let lookups = 0;
    await assert.rejects(
      confirmTicketPhoto(
        session,
        { ticketId, path, fileName: "a.jpg", mime: "image/jpeg", size: 40, internal: false, uploadToken: token },
        {
          target,
          existing: async () => {
            lookups += 1;
            return lookups === 1 ? null : "att";
          },
          info: async () => ({ ok: true, size: 40, mime: "image/jpeg" }),
          header: async () => {
            throw new FlowError("errors.photoStorage");
          },
          remove,
        },
      ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.photoStorage",
    );
    assert.equal(lookups, 2);
    assert.deepEqual(removed, []);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous;
  }
});
