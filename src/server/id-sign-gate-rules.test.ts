import assert from "node:assert/strict";
import test from "node:test";
import { idSignGateFlagOn, resolveIdSignGate, signingRequiresIdentity } from "./id-sign-gate-rules";

const ORG = "11111111-1111-4111-8111-111111111111";

test("defaults: collect_id true, require_id_before_sign false ⇒ collect (non-blocking)", () => {
  assert.deepEqual(resolveIdSignGate({}), { collectId: true, requireIdBeforeSign: false, mode: "collect" });
  assert.deepEqual(resolveIdSignGate(null), { collectId: true, requireIdBeforeSign: false, mode: "collect" });
});

test("only master ∧ sub ON blocks; master OFF ∧ sub ON is invalid and never blocks", () => {
  assert.equal(resolveIdSignGate({ collect_id: true, require_id_before_sign: true }).mode, "block");
  assert.equal(resolveIdSignGate({ collect_id: false, require_id_before_sign: true }).mode, "invalid");
  assert.equal(resolveIdSignGate({ collect_id: false }).mode, "off");
  for (const mode of ["collect", "off", "invalid"] as const) assert.equal(signingRequiresIdentity(true, { collectId: true, requireIdBeforeSign: false, mode }), false);
  assert.equal(signingRequiresIdentity(true, resolveIdSignGate({ collect_id: true, require_id_before_sign: true })), true);
});

test("present non-boolean values fail closed (block); flag OFF keeps the legacy hard gate", () => {
  assert.equal(resolveIdSignGate({ collect_id: "false", require_id_before_sign: "true" }).mode, "block");
  assert.equal(resolveIdSignGate({ collect_id: true, require_id_before_sign: "true" }).mode, "block");
  assert.equal(resolveIdSignGate({ require_id_before_sign: null }).mode, "block");
  assert.equal(signingRequiresIdentity(true, resolveIdSignGate({ collect_id: 1 })), true);
  assert.equal(signingRequiresIdentity(false, resolveIdSignGate({})), true);
});

test("flag needs global enabled===true, allowlisted org and org flag true", () => {
  assert.equal(idSignGateFlagOn({ enabled: true, allowed_org_ids: [ORG] }, { id_sign_gate_v2: true }, ORG), true);
  assert.equal(idSignGateFlagOn({ enabled: "true", allowed_org_ids: [ORG] }, { id_sign_gate_v2: true }, ORG), false);
  assert.equal(idSignGateFlagOn({ enabled: true, allowed_org_ids: [] }, { id_sign_gate_v2: true }, ORG), false);
  assert.equal(idSignGateFlagOn({ enabled: true, allowed_org_ids: [ORG] }, { id_sign_gate_v2: "true" }, ORG), false);
});
