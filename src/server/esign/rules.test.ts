import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptableSignature,
  auditView,
  createCase,
  EMAIL_IDENTITY_LABEL,
  idPhotoPurgeMayDelete,
  replacementLine,
  retentionAction,
  retentionUntil,
  transition,
  validateReplacementBody,
  type Event,
  type SigningCase,
} from "./rules";

const at = "2026-10-26T16:30:00Z";
const deadline = "2026-10-27T16:30:00Z";
const hash = "a".repeat(64);
const finalHash = "b".repeat(64);
const strokes = [[{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 10 }]];
const admin = { actorId: "staff", role: "company_admin" as const, at };

function draft() {
  return createCase({
    versionId: "v1",
    body: "Contract",
    documentDigest: hash,
    signers: [{ id: "o", role: "owner" }, { id: "t", role: "tenant" }],
  });
}

function send(state = draft(), versionId = "v1") {
  return transition(state, {
    ...admin, versionId, type: "send",
    presumedConsentDeadline: deadline, termsVersion: "terms-1",
  });
}

function actor(id: string, versionId = "v1") {
  return { actorId: id, signerId: id, role: id === "o" ? "owner" as const : "tenant" as const, at, versionId };
}

function prepare(state: SigningCase, id: string, versionId = "v1") {
  const base = actor(id, versionId);
  let s = transition(state, { ...base, type: "consent", kind: "explicit" });
  s = transition(s, { ...base, type: "issue_identity", method: "email", expiresAt: deadline, attemptCap: 2 });
  s = transition(s, { ...base, type: "check_identity", method: "email", codeMatches: true });
  return transition(s, { ...base, type: "review", scrolledToEnd: true });
}

function signEvent(id: string, versionId = "v1"): Event {
  return {
    ...actor(id, versionId), type: "sign", strokes, imageRef: "signature.png",
    documentDigest: hash, finalDigest: finalHash, ip: "192.0.2.1",
    userAgent: "Fixture", device: "fixture-device",
  };
}

function finish(state = send(), versionId = "v1") {
  let s = transition(prepare(state, "o", versionId), signEvent("o", versionId));
  s = transition(prepare(s, "t", versionId), signEvent("t", versionId));
  return s;
}

function replacement(state = finish(), body = `${replacementLine(at)}\nNew contract`) {
  return transition(state, {
    ...admin, versionId: "v1", type: "create_version",
    newVersionId: "v2", body, documentDigest: hash,
  });
}

test("draft, sent, signing and completed transitions are detached and lock the final PDF", () => {
  const initial = draft();
  const sent = send(initial);
  assert.equal(initial.versions[0].status, "draft");
  assert.equal(sent.versions[0].status, "sent");
  const prepared = prepare(sent, "o");
  assert.equal(prepared.versions[0].status, "signing");
  assert.equal(prepared.versions[0].signers[0].status, "pending_signature");
  const done = finish(sent);
  assert.equal(done.versions[0].status, "completed");
  assert.equal(done.versions[0].effect, "effective");
  assert.equal(done.versions[0].finalDigest, finalHash);
  assert.equal(done.versions[0].signers.every((s) => s.status === "completed"), true);
  assert.throws(() => transition(done, { ...admin, versionId: "v1", type: "void", reason: "change" }));
});

test("illegal order, duplicate steps, actor mismatch and unknown versions throw", () => {
  const s = send();
  assert.throws(() => transition(draft(), { ...actor("o"), type: "consent", kind: "explicit" }));
  assert.throws(() => send(s));
  assert.throws(() => transition(s, signEvent("o")));
  assert.throws(() => transition(s, { ...actor("o"), type: "review", scrolledToEnd: true }));
  assert.throws(() => transition(s, { ...actor("o"), actorId: "t", type: "consent", kind: "explicit" }));
  assert.throws(() => transition(s, { ...actor("o", "missing"), type: "consent", kind: "explicit" }));
  const consented = transition(s, { ...actor("o"), type: "consent", kind: "explicit" });
  assert.throws(() => transition(consented, { ...actor("o"), type: "consent", kind: "explicit" }));
  assert.throws(() => transition(s, { ...admin, role: "company_staff", versionId: "v1", type: "void", reason: "x" }));
  assert.throws(() => transition(s, { ...admin, versionId: "v1", type: "void", reason: " " }));
});

test("presumed consent uses the supplied deadline with an inclusive boundary", () => {
  const s = send();
  assert.throws(() => transition(s, {
    ...actor("o"), at: "2026-10-27T16:29:59.999Z", type: "consent", kind: "presumed",
  }));
  const accepted = transition(s, { ...actor("o"), at: deadline, type: "consent", kind: "presumed" });
  assert.equal(accepted.versions[0].signers[0].consent?.kind, "presumed");
  const later = transition(draft(), {
    ...admin, versionId: "v1", type: "send",
    presumedConsentDeadline: "2026-11-30T00:00:00Z", termsVersion: "terms-2",
  });
  assert.throws(() => transition(later, { ...actor("o"), at: deadline, type: "consent", kind: "presumed" }));
});

test("objection halts everyone and can follow explicit consent", () => {
  const consented = transition(send(), { ...actor("o"), type: "consent", kind: "explicit" });
  const halted = transition(consented, { ...actor("o"), type: "object" });
  assert.equal(halted.versions[0].halted, "objection");
  assert.throws(() => transition(halted, { ...actor("t"), type: "consent", kind: "explicit" }));
  const voided = transition(halted, { ...admin, versionId: "v1", type: "void", reason: "Restart" });
  assert.equal(voided.versions[0].status, "voided");
});

function challenge(attemptCap = 2) {
  const consented = transition(send(), { ...actor("o"), type: "consent", kind: "explicit" });
  return transition(consented, {
    ...actor("o"), type: "issue_identity", method: "email", expiresAt: deadline, attemptCap,
  });
}

test("email attempts, expiry, retry and result values", () => {
  const failed = transition(challenge(), { ...actor("o"), type: "check_identity", method: "email", codeMatches: false });
  assert.equal(failed.versions[0].signers[0].identity?.result, "failed");
  assert.equal(failed.versions[0].halted, undefined);
  const success = transition(failed, { ...actor("o"), type: "check_identity", method: "email", codeMatches: true });
  assert.equal(success.versions[0].signers[0].identity?.result, "completed");
  assert.equal(success.versions[0].signers[0].identity?.attempts, 2);
  assert.equal(success.versions[0].signers[0].emailChallenge, undefined);
  const capped = transition(challenge(1), { ...actor("o"), type: "check_identity", method: "email", codeMatches: false });
  assert.equal(capped.versions[0].halted, "identity_failed");
  assert.throws(() => transition(capped, { ...actor("o"), type: "check_identity", method: "email", codeMatches: true }));
  const expired = transition(challenge(), { ...actor("o"), at: deadline, type: "check_identity", method: "email", codeMatches: true });
  assert.equal(expired.versions[0].signers[0].identity?.result, "failed");
  assert.equal(expired.versions[0].halted, "identity_failed");
  const before = transition(challenge(), {
    ...actor("o"), at: "2026-10-27T16:29:59.999Z",
    type: "check_identity", method: "email", codeMatches: true,
  });
  assert.equal(before.versions[0].signers[0].identity?.result, "completed");
  assert.throws(() => challenge(0));
  assert.throws(() => transition(challenge(), {
    ...actor("o"), type: "issue_identity", method: "email", expiresAt: deadline, attemptCap: 100,
  }));
});

test("OTP is declared but unavailable for issue and check", () => {
  const consented = transition(send(), { ...actor("o"), type: "consent", kind: "explicit" });
  assert.throws(() => transition(consented, {
    ...actor("o"), type: "issue_identity", method: "otp", expiresAt: deadline, attemptCap: 2,
  }), /not available/);
  assert.throws(() => transition(challenge(), {
    ...actor("o"), type: "check_identity", method: "otp", codeMatches: true,
  }), /not available/);
});

test("foreign document record contains only document type, staff and time", () => {
  for (const documentType of ["passport", "residence_permit"] as const) {
    const event = {
      ...admin, versionId: "v1", signerId: "o", type: "check_foreign_document" as const,
      documentType, documentNumber: "MUST-NOT-PERSIST",
    };
    const state = transition(send(), event);
    assert.deepEqual(state.versions[0].signers[0].foreignDocumentCheck, {
      documentType, checkedByStaffId: "staff", checkedAt: at,
    });
    assert.equal(JSON.stringify(state).includes("MUST-NOT-PERSIST"), false);
    assert.throws(() => transition(send(), { ...event, role: "owner", actorId: "o" }));
  }
});

test("review gate, empty and tiny signatures, digest binding and complete audit fields", () => {
  const identity = transition(challenge(), {
    ...actor("o"), type: "check_identity", method: "email", codeMatches: true,
  });
  assert.throws(() => transition(identity, { ...actor("o"), type: "review", scrolledToEnd: false }));
  assert.equal(acceptableSignature([]), false);
  assert.equal(acceptableSignature([[{ x: 0, y: 0 }]]), false);
  assert.equal(acceptableSignature([[{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]]), false);
  assert.equal(acceptableSignature([[{ x: NaN, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }]]), false);
  assert.equal(acceptableSignature(strokes), true);
  const ready = prepare(send(), "o");
  const good = signEvent("o");
  assert.equal(good.type, "sign");
  if (good.type !== "sign") throw new Error("Fixture");
  assert.throws(() => transition(ready, { ...good, strokes: [], checkbox: true } as Event));
  assert.throws(() => transition(ready, { ...good, documentDigest: finalHash }));
  for (const key of ["ip", "userAgent", "device", "imageRef"] as const) {
    assert.throws(() => transition(ready, { ...good, [key]: "" }));
  }
});

test("sequential signing blocks later party until predecessor completes", () => {
  const d = draft();
  d.versions[0].order = "sequential";
  const s = send(d);
  assert.throws(() => prepare(s, "t"));
  const first = transition(prepare(s, "o"), signEvent("o"));
  assert.doesNotThrow(() => prepare(first, "t"));
});

test("incomplete versions can be voided and re-signing resets every signer step", () => {
  const partiallySigned = transition(prepare(send(), "o"), signEvent("o"));
  const voided = transition(partiallySigned, {
    ...admin, versionId: "v1", type: "void", reason: "Correction",
  });
  assert.equal(voided.versions[0].voided_by, "staff");
  assert.equal(voided.versions[0].voided_at, at);
  assert.equal(voided.versions[0].voidReason, "Correction");
  const fresh = transition(voided, {
    ...admin, versionId: "v1", type: "create_version",
    newVersionId: "v2", body: "Corrected contract", documentDigest: hash,
  });
  assert.deepEqual(fresh.versions[0], voided.versions[0]);
  assert.equal(fresh.versions[1].previous_version_id, "v1");
  assert.equal(fresh.versions[1].signers.every((s) =>
    s.status === "pending_consent" && !s.identity && !s.consent && !s.signature), true);
  assert.equal(finish(send(fresh, "v2"), "v2").versions[1].effect, "effective");
});

test("Q8 old version remains effective until the final replacement signature", () => {
  const old = finish();
  const snapshot = structuredClone(old);
  const fresh = replacement(old);
  assert.deepEqual(old, snapshot);
  assert.deepEqual(fresh.versions[0], old.versions[0]);
  assert.equal(fresh.versions[1].supersedes_version_id, "v1");
  assert.equal(fresh.versions[1].initiatedBy, "staff");
  assert.equal(fresh.versions[1].initiatedAt, at);
  const one = transition(prepare(send(fresh, "v2"), "o", "v2"), signEvent("o", "v2"));
  assert.equal(one.versions[0].effect, "effective");
  assert.equal(one.versions[1].effect, "pending");
  const ready = prepare(one, "t", "v2");
  const last = signEvent("t", "v2");
  if (last.type !== "sign") throw new Error("Fixture");
  assert.throws(() => transition(ready, { ...last, finalDigest: undefined }));
  assert.equal(ready.versions[0].effect, "effective");
  const done = transition(ready, last);
  assert.equal(done.versions[0].status, "superseded");
  assert.equal(done.versions[0].effect, "superseded");
  assert.equal(done.versions[1].effect, "effective");
  assert.equal(done.versions[1].completedAt, at);
  assert.deepEqual(done.audit.slice(0, old.audit.length), old.audit);
  assert.equal(done.versions[0].finalDigest, old.versions[0].finalDigest);
  assert.throws(() => transition(done, {
    ...admin, versionId: "v1", type: "void", reason: "No",
  }));
  assert.throws(() => transition(done, {
    ...admin, versionId: "v1", type: "create_version",
    newVersionId: "v3", body: replacementLine(at), documentDigest: hash,
  }));
  assert.throws(() => transition(done, signEvent("o")));
});

test("voiding a pending replacement preserves the effective original", () => {
  const fresh = send(replacement(), "v2");
  const one = transition(prepare(fresh, "o", "v2"), signEvent("o", "v2"));
  const voided = transition(one, { ...admin, versionId: "v2", type: "void", reason: "Stop replacement" });
  assert.equal(voided.versions[0].effect, "effective");
  assert.equal(voided.versions[1].effect, "voided");
  assert.deepEqual(voided.versions[0], one.versions[0]);
  assert.throws(() => transition(voided, signEvent("t", "v2")));
  const retry = transition(voided, {
    ...admin, versionId: "v2", type: "create_version",
    newVersionId: "v3", body: replacementLine(at), documentDigest: hash,
  });
  assert.equal(retry.versions[2].supersedes_version_id, "v1");
  const done = finish(send(retry, "v3"), "v3");
  assert.equal(done.versions[0].effect, "superseded");
  assert.equal(done.versions[2].effect, "effective");
});

test("replacement line uses Asia/Taipei completion date and is mandatory", () => {
  assert.equal(replacementLine(at), "本版取代 2026-10-27 簽署之前版");
  assert.equal(validateReplacementBody(`Header\n${replacementLine(at)}\nBody`, at), true);
  assert.equal(validateReplacementBody(`Not ${replacementLine(at)}`, at), false);
  assert.throws(() => replacement(finish(), "Missing line"));
  assert.throws(() => replacement(finish(), "本版取代 2026-10-26 簽署之前版"));
  assert.throws(() => transition(replacement(), {
    ...admin, versionId: "v1", type: "create_version",
    newVersionId: "v3", body: replacementLine(at), documentDigest: hash,
  }));
});

test("role visibility matrix excludes technical data except for company admin", () => {
  const version = finish().versions[0];
  for (const viewer of [
    { id: "o", role: "owner" as const },
    { id: "t", role: "tenant" as const },
    { id: "staff", role: "company_staff" as const },
    { id: "staff", role: "company_admin" as const },
  ]) {
    const view = auditView(version, "o", viewer);
    assert.equal(view.identityLabel, EMAIL_IDENTITY_LABEL);
    assert.equal(view.signedAt, at);
    assert.equal(view.documentDigest, finalHash);
    for (const key of ["ip", "device", "userAgent"]) {
      assert.equal(key in view, viewer.role === "company_admin");
    }
  }
  assert.throws(() => auditView(version, "o", { id: "stranger", role: "owner" }));
  assert.throws(() => auditView(version, "o", { id: "o", role: "tenant" }));
});

test("Q9 calendar retention, leap day and Taipei midnight boundary", () => {
  assert.equal(retentionUntil("2026-10-26"), "2041-10-26");
  assert.equal(retentionUntil("2024-02-29"), "2039-02-28");
  assert.equal(retentionUntil("2084-02-29"), "2099-02-28");
  assert.throws(() => retentionUntil("2023-02-29"));
  assert.throws(() => retentionUntil(""));
  assert.equal(retentionAction("2041-10-25T15:59:59Z", "2026-10-26"), "retain");
  assert.equal(retentionAction("2041-10-25T16:00:00Z", "2026-10-26"), "eligible_for_delete_or_anonymize");
  assert.equal(retentionAction("2041-10-26", "2026-10-26"), "eligible_for_delete_or_anonymize");
  assert.equal(retentionAction(new Date("2041-10-25T16:00:00Z"), "2026-10-26"), "eligible_for_delete_or_anonymize");
});

test("ID-photo purge cannot delete any e-sign record kind", () => {
  assert.equal(idPhotoPurgeMayDelete("id_photo"), true);
  for (const kind of [
    "signed_lease_pdf", "esign_audit_event", "esign_signature_image",
    "esign_document_digest", "", "unknown",
  ]) assert.equal(idPhotoPurgeMayDelete(kind), false);
});
