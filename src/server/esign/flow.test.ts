import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { PNG } from "pngjs";
import { PDFDocument } from "pdf-lib";
import { buildStoredConsent } from "../consent";
import type { Session } from "../types";
import { EsignDenied, EsignUnavailable, esignEnabled, management, requireManagement } from "./access";
import { EsignFlow, type Command } from "./flow";
import { emailCode, matchesEmailCode } from "./email";
import { signaturePng } from "./evidence";
import { contractVersionDigest } from "./document";
import type { Connection } from "./repo";
import { requireReviewDelivery, type ReviewBinding } from "./review";
import { esignUi } from "../../i18n/lanes/esign";

const session: Session = {
  userId: "20000000-0000-4000-8000-000000000001", orgId: "10000000-0000-4000-8000-000000000001",
  liveOrgId: "10000000-0000-4000-8000-000000000001", sessionId: "synthetic-session",
  kind: "staff", role: "admin", locale: "zh-TW", calendar: "gregorian", environment: "live",
  leaseId: null, email: "admin@example.com", name: "Synthetic", consent: buildStoredConsent("reconsent"),
};
const id = "30000000-0000-4000-8000-000000000001";
const commands: Command[] = [
  { type: "create", leaseId: id, pdf: new Uint8Array(), ownerId: id, tenantId: id,
    ownerDocument: false, tenantDocument: false, order: "parallel", deadline: "" },
  ...(["consent", "object", "email", "review"] as const).map((type) => ({ type, caseId: id, versionId: id })),
  { type: "confirm", caseId: id, versionId: id, response: "" },
  { type: "void", caseId: id, versionId: id, reason: "" },
  { type: "replace", caseId: id, versionId: id, body: "", deadline: "" },
  { type: "document", caseId: id, versionId: id, signerId: id, documentType: "passport" },
  { type: "sign", caseId: id, versionId: id, strokes: [], digest: "", ip: "", userAgent: "" },
];

test("default flag is false; every action operation and read stops before SQL/mail", async () => {
  const before = process.env.ESIGN_ENABLED;
  try {
    delete process.env.ESIGN_ENABLED;
    assert.equal(esignEnabled(), false);
    process.env.ESIGN_ENABLED = "TRUE";
    assert.equal(esignEnabled(), false);
    let calls = 0;
    const flow = new EsignFlow({ enabled: () => false, run: async () => { calls++; throw new Error("SQL"); } });
    for (const command of commands) await assert.rejects(flow.execute(session, command), EsignUnavailable);
    await assert.rejects(flow.list(session, id), EsignUnavailable);
    await assert.rejects(flow.pdf(session, id, id, false), EsignUnavailable);
    assert.equal(calls, 0);
    await assert.rejects(flow.execute({ ...session, consent: null }, commands[0]), (e: unknown) => e instanceof EsignDenied && e.message === "consent");
  } finally {
    if (before === undefined) delete process.env.ESIGN_ENABLED;
    else process.env.ESIGN_ENABLED = before;
  }
});

test("management matrix and stale membership cannot create a case", async () => {
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    const actor = { ...session, role };
    assert.equal(management(actor), role === "admin" || role === "manager");
    if (role === "admin" || role === "manager") requireManagement(actor);
    else assert.throws(() => requireManagement(actor), EsignDenied);
    if (role !== "admin") assert.throws(() => requireManagement(actor, true), EsignDenied);
  }
  assert.throws(() => requireManagement({ ...session, kind: "owner" }), EsignDenied);
  const flow = new EsignFlow({ enabled: () => true, run: async (_id, work) => work({
    query: (async () => ({ rows: [], rowCount: 0 })) as never,
  }) });
  await assert.rejects(flow.execute(session, commands[0]), /Membership changed/);
  await assert.rejects(flow.execute({ ...session, role: "accountant" }, commands[0]), EsignDenied);
  await assert.rejects(flow.execute({ ...session, kind: "tenant", role: null }, commands[0]), EsignDenied);
});

test("Email codes bind every challenge dimension and do not contain the secret", async () => {
  const secret = "synthetic-only-secret-material-32-bytes";
  const input = { caseId: "case", versionId: "version", signerId: "signer", email: "person@example.com", issuedAt: "2026-10-26T12:00:00Z" };
  const code = await emailCode(input, secret);
  assert.match(code, /^[a-f0-9]{32}$/);
  assert.equal(code, await emailCode(input, secret));
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    assert.notEqual(code, await emailCode({ ...input, [key]: input[key] + "other" }, secret));
  }
  assert.equal(await matchesEmailCode(code, code), true);
  assert.equal(await matchesEmailCode(code, "wrong"), false);
  await assert.rejects(emailCode(input, ""), /32 bytes/);
});

test("server raster accepts handwriting and rejects empty/out-of-bounds/resource abuse", () => {
  const strokes = [[{ x: 4, y: 4 }, { x: 20, y: 30 }, { x: 50, y: 10 }]];
  const bytes = signaturePng(strokes);
  const decoded = PNG.sync.read(Buffer.from(bytes));
  assert.equal(decoded.width, 721);
  assert.equal(decoded.height, 241);
  assert.ok(decoded.data.some((value, i) => i % 4 === 3 && value === 255));
  assert.throws(() => signaturePng([]));
  assert.throws(() => signaturePng([[{ x: -1, y: 0 }, { x: 10, y: 10 }, { x: 30, y: 20 }]]));
  assert.throws(() => signaturePng(Array.from({ length: 101 }, () => strokes[0])));
});

test("all mounted entrypoints guard consent before flag, session and business access", () => {
  const paths = [
    "src/server/esign/actions.ts", "src/app/api/esign/[caseId]/[versionId]/route.ts",
    "src/app/m/leases/[id]/layout.tsx", "src/app/t/lease/layout.tsx",
    "src/app/o/leases/[id]/esign/page.tsx",
  ];
  for (const path of paths) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const functions = source.statements.filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    assert.ok(functions.length, path);
    for (const fn of functions) {
      const statements = fn.body!.statements;
      assert.match(statements[0].getText(source), /await requireCurrentConsent\(/, path);
      assert.match(statements[path.endsWith("/route.ts") ? 2 : 1].getText(source), /!esignEnabled\(\)/, path);
    }
  }
});

test("90-day purge entrypoints and their SQL functions never name e-sign tables", () => {
  const docs = readFileSync("src/server/id-docs.ts", "utf8");
  const body = docs.slice(docs.indexOf("export async function purgeDueIdDocuments("), docs.indexOf("export async function backfillIdWatermarks("));
  assert.doesNotMatch(body, /esign_/i);
  assert.doesNotMatch(readFileSync("id-purge-cron.mjs", "utf8"), /esign_/i);
  let found = 0;
  for (const file of readdirSync("supabase/migrations").filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync("supabase/migrations/" + file, "utf8");
    for (const match of sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?purge_due_identity_documents\([\s\S]*?\$\$;/gi)) {
      assert.doesNotMatch(match[0], /esign_/i, file); found++;
    }
  }
  assert.ok(found > 0);
});

test("mounted copy follows the lane's banned-word and guarantee rules", () => {
  const text = JSON.stringify(esignUi);
  for (const word of ["收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付", "統一編號", "含稅", "本公司", "事務所", "已驗證", "保證有效", "保證具法律效力"]) {
    assert.equal(text.includes(word), false, word);
  }
  assert.doesNotMatch(text, /guarantee(?:d|s)?\s+(?:to\s+be\s+)?(?:legally\s+binding|legal(?:ly)?\s+valid(?:ity)?)/i);
});

test("direct review submission requires complete, signer/version/digest-bound delivery", async () => {
  const signer: Session = { ...session, kind: "tenant", role: null };
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const digest = await contractVersionDigest(bytes);
  const binding: ReviewBinding = { caseId: id, versionId: id, signerId: signer.userId, digest };
  const deliveries: { actorId: string; payload: ReviewBinding & { page: number | null } }[] = [];
  let stateDigest = digest;
  const c: Connection = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT lease_id::text")) return { rows: [{ lease_id: id }], rowCount: 1 };
      if (sql.startsWith("SELECT state,pdf_bytes,final_pdf_bytes")) {
        return { rows: [{
          state: { documentDigest: stateDigest, signers: [{ id: signer.userId, role: "tenant", status: "pending_review" }] },
          pdf_bytes: bytes, final_pdf_bytes: null,
        }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT 1 FROM org_members")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO esign_audit_events")) {
        assert.match(sql, /'review_delivery'/);
        deliveries.push({ actorId: signer.userId, payload: JSON.parse(params[2] as string) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT payload FROM esign_audit_events")) {
        assert.match(sql, /actor_id=\$3/);
        assert.match(sql, /event_type='review_delivery'/);
        assert.match(sql, /payload @> \$4::jsonb/);
        const expected = JSON.parse(params[3] as string) as ReviewBinding;
        const rows = deliveries.filter((row) => row.actorId === params[2] &&
          row.payload.caseId === params[0] && row.payload.versionId === params[1] &&
          (Object.keys(expected) as (keyof ReviewBinding)[]).every((key) => row.payload[key] === expected[key]));
        return { rows, rowCount: rows.length };
      }
      throw new Error("Unexpected SQL: " + sql);
    }) as Connection["query"],
  };
  const flow = new EsignFlow({ enabled: () => true, run: async (_actor, work) => work(c) });
  const review: Command = { type: "review", caseId: id, versionId: id };

  await assert.rejects(flow.execute(signer, review), /Document delivery required/);
  assert.equal(deliveries.length, 0);
  await assert.rejects(flow.pdf(signer, id, id, false, 3));
  assert.equal(deliveries.length, 0);

  await flow.pdf(signer, id, id, false, 1);
  await flow.pdf(signer, id, id, false, 1);
  await assert.rejects(flow.execute(signer, review), /Document delivery required/);
  await flow.pdf(signer, id, id, false, 2);
  await requireReviewDelivery(c, binding, 2);

  for (const key of Object.keys(binding) as (keyof ReviewBinding)[]) {
    await assert.rejects(requireReviewDelivery(c, { ...binding, [key]: binding[key] + "-other" }, 2), /Document delivery required/);
  }
  stateDigest = "0".repeat(64);
  await assert.rejects(flow.execute(signer, review), /Document delivery required/);
  const count = deliveries.length;
  await assert.rejects(flow.pdf(signer, id, id, false), /Document digest mismatch/);
  assert.equal(deliveries.length, count);

  stateDigest = digest;
  deliveries.length = 0;
  await flow.pdf(signer, id, id, false);
  assert.equal(deliveries[0].payload.page, null);
  await requireReviewDelivery(c, binding, 2);
});
