import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { uploadRecoveryCopy } from "../i18n/upload-recovery";

// B-031 UPLOAD_RECOVERY OFF equality. The base (1bba9f3) uploader element, verbatim.
const golden = [
  "<TicketPhotoUpload",
  "  ticketId={ticketId}",
  '  label={t("i_repair_photo_add")}',
  '  chooseLabel={t("i_repair_photo_choose")}',
  '  hint={t("i_repair_photo_hint")}',
  "  allowInternal={allowInternal}",
  "  messages={{",
  '    size: t("i_photo_size"),',
  '    type: t("i_photo_type"),',
  '    heic: t("i_photo_heic"),',
  '    storage: t("i_photo_storage"),',
  '    limit: t("i_photo_limit"),',
  '    generic: t("i_generic"),',
  '    internal: t("i_repair_internal"),',
  '    internalHint: t("i_repair_internal_hint"),',
  '    wait: t("i_repair_upload_wait"),',
  '    failed: t("i_repair_photo_failed"),',
  "  }}",
  "/>",
].join("\n");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("flag OFF (uploadRecovery null) renders the unchanged single-photo uploader", () => {
  const source = read("./repair-thread.tsx");
  assert.match(source, /  uploadRecovery = null,\n/);
  const on = source.indexOf("{canUpload && uploadRecovery ? (");
  const off = source.indexOf(") : canUpload ? (\n        <TicketPhotoUpload");
  assert.ok(on > 0 && off > on, "batch uploader only behind a truthy uploadRecovery");
  const block = source.slice(off).match(/\n {8}(<TicketPhotoUpload[\s\S]*?\n {8}\/>)\n {6}\) : null\}/)?.[1];
  assert.ok(block);
  assert.equal(block.split("\n").map((line, i) => (i === 0 ? line : line.slice(8))).join("\n"), golden);
  assert.equal(source.match(/<TicketPhotoUpload\b/g)?.length, 1);
  assert.equal(source.match(/<TicketPhotoBatchUpload\b/g)?.length, 1);
  // The unchanged single-photo component is not edited by this slice.
  assert.doesNotMatch(read("./ticket-photos.tsx"), /multiple|batchKey|clientKey/);
});

test("pages pass only ticketPhotoRecovery() output, which is null when OFF", () => {
  for (const [file, guard] of [
    ["../app/m/tickets/[id]/page.tsx", "const uploadRecovery = canWrite ? await ticketPhotoRecovery(session, id) : null;"],
    ["../app/t/repair/page.tsx", "const uploadRecovery = own ? await ticketPhotoRecovery(session, own.ticket.id) : null;"],
  ] as const) {
    const source = read(file);
    assert.ok(source.includes(guard), file);
    assert.equal(source.match(/uploadRecovery=\{uploadRecovery\}/g)?.length, 1, file);
  }
  const server = read("../server/upload-recovery.ts");
  const body = server.slice(server.indexOf("export async function ticketPhotoRecovery"));
  assert.match(body, /^[^\n]*\n {2}if \(!\(await uploadRecoveryEnabled\(session\.orgId\)\)\) return null;\n/);
});

test("upload recovery copy exists in EN and zh-TW with the same keys and no forbidden terms", () => {
  const en = uploadRecoveryCopy("en"), zh = uploadRecoveryCopy("zh-TW");
  assert.deepEqual(Object.keys(zh), Object.keys(en));
  for (const value of [...Object.values(en), ...Object.values(zh)]) assert.ok(value.trim().length > 0);
  assert.ok(en.submit.includes("{count}") && zh.submit.includes("{count}"));
  for (const word of ["房東", "房客", "收款", "收租", "入帳", "已收", "統一編號"]) {
    assert.ok(!Object.values(zh).some((value) => value.includes(word)), word);
  }
  assert.notEqual(en.retry, zh.retry);
});

test("batch uploader: 'kept' copy only when a restored file is uploaded; remove/discard and closed-draft recovery wired", () => {
  const source = read("./ticket-photo-batch.tsx");
  assert.match(source, /const restoredKept = Boolean\(draft\?\.items\.some\(\(item\) => item\.state === "uploaded"\)\);/);
  assert.match(source, /\{restoredKept \? <p className="tiny" data-testid="repair-photo-restored">\{copy\.restored\}<\/p> : null\}/);
  assert.equal(source.match(/copy\.restored/g)?.length, 1);
  assert.match(source, /if \(state === "closed"\) \{[\s\S]*?startNewDraft\(\);\n\s*await send\(item, true\);/);
  assert.match(source, /op: clientKey \? "remove" : "discard"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
  // Route order (documented): session 401 -> consent gate -> handleUploadBatch (one flag read, 404 when OFF).
  const route = read("../app/api/tickets/photos/batch/route.ts");
  const order = ["await readSession()", 'await requireCurrentConsent(session, "api")', "await handleUploadBatch(request, session)"].map((call) => route.indexOf(call));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), "route order");
  const handler = read("../server/upload-recovery-route.ts");
  const flag = handler.indexOf("if (!(await uploadRecoveryEnabled(session.orgId))) return NextResponse.json");
  assert.ok(flag > 0 && flag < handler.indexOf("await request.json()"), "flag read before parsing or any op");
});
