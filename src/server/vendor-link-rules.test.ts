import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderableTypeFields,
  vendorLinkCapability,
  vendorLinkGlobalOn,
  vendorLinkOn,
  vendorLinkSafeView,
} from "./vendor-link-rules";

test("vendor_link requires platform_settings allowlist and org flag", () => {
  const org = "11111111-1111-1111-1111-111111111111";
  const other = "22222222-2222-2222-2222-222222222222";
  const orgFlags: Array<[unknown, boolean]> = [
    [undefined, false], [null, false], [false, false], [true, false],
    ["true", false], [1, false], [[], false], [{}, false],
    [{ vendor_link: null }, false], [{ vendor_link: false }, false],
    [{ vendor_link: "false" }, false], [{ vendor_link: 1 }, false],
    [{ vendor_link: "TRUE" }, false], [{ vendor_link: " true" }, false],
    [{ vendor_link: {} }, false], [{ vendor_link: [] }, false],
    [{ vendor_link: true }, true], [{ vendor_link: "true" }, true],
  ];
  const globals: Array<[unknown, boolean, boolean]> = [
    [undefined, false, false],
    [null, false, false],
    [[], false, false],
    [{ enabled: false }, false, false],
    [{ enabled: false, allowed_org_ids: [org] }, false, false],
    [{ enabled: "true", allowed_org_ids: [org] }, false, false],
    [{ enabled: true }, false, false],
    [{ enabled: true, allowed_org_ids: org }, false, false],
    [{ enabled: true, allowed_org_ids: [other] }, false, true],
    [{ enabled: true, allowed_org_ids: [org] }, true, true],
  ];
  for (const [global, gateOpen] of globals) {
    for (const [flag, flagOn] of orgFlags) {
      assert.equal(vendorLinkOn(global, flag, org), gateOpen && flagOn);
    }
  }
  for (const [global, , globalOn] of globals) {
    assert.equal(vendorLinkGlobalOn(global), globalOn);
  }
});

const now = new Date("2026-10-25T12:00:00Z");
const valid = {
  ticketStatus: "assigned",
  active: true,
  revokedAt: null,
  expiresAt: "2026-10-25T12:00:01Z",
  now,
};

test("capability mirrors #55 reportable states and closes terminal states", () => {
  for (const ticketStatus of ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved"]) {
    assert.equal(vendorLinkCapability({ ...valid, ticketStatus }), "write");
  }
  for (const ticketStatus of ["closed", "cancelled", "unknown", ""]) {
    assert.equal(vendorLinkCapability({ ...valid, ticketStatus }), "read_only");
  }
});

test("inactive, revoked, expired and malformed links are invalid", () => {
  assert.equal(vendorLinkCapability({ ...valid, active: false }), "invalid");
  for (const revokedAt of [now, now.toISOString(), ""]) {
    assert.equal(vendorLinkCapability({ ...valid, revokedAt }), "invalid");
  }
  for (const expiresAt of [now, now.toISOString(), "2026-10-25T11:59:59Z", "invalid"]) {
    assert.equal(vendorLinkCapability({ ...valid, expiresAt }), "invalid");
  }
  assert.equal(vendorLinkCapability({ ...valid, now: new Date("invalid") }), "invalid");
  assert.equal(vendorLinkCapability({ ...valid, ticketStatus: "closed", active: false }), "invalid");
});

test("safe view copies only explicit display fields, including photo fields", () => {
  const input = {
    address: "Address",
    place: "Room",
    title: "Repair",
    description: "Shared description",
    window: "Monday",
    status: "assigned",
    expiresAt: valid.expiresAt,
    ticketNumber: "T-123",
    issuePhotos: [{ id: "photo-1", name: "issue.jpg", storage_path: "private", tenantIdDoc: "secret" }],
    donePhotos: [{ id: "photo-2", name: "done.jpg", ownerPhone: "secret" }],
    tenantIdDoc: "secret",
    ownerPhone: "secret",
    internalNote: "secret",
    token: "secret",
    type_fields: { private: "secret" },
  };
  const view = vendorLinkSafeView(input);
  assert.deepEqual(view, {
    address: "Address",
    place: "Room",
    title: "Repair",
    description: "Shared description",
    window: "Monday",
    status: "assigned",
    expiresAt: valid.expiresAt,
    ticketNumber: "T-123",
    issuePhotos: [{ id: "photo-1", name: "issue.jpg" }],
    donePhotos: [{ id: "photo-2", name: "done.jpg" }],
  });
  assert.notEqual(view.issuePhotos, input.issuePhotos);
  assert.equal(JSON.stringify(view).includes("secret"), false);
  assert.equal("ticketNumber" in vendorLinkSafeView(null), false);
  assert.deepEqual(vendorLinkSafeView({
    issuePhotos: [null, {}, { id: 1, name: "bad" }],
    donePhotos: "bad",
  }).issuePhotos, []);
});

test("per-type templates expose no fields before the job_types migration", () => {
  for (const jobType of [null, "", "cleaning", "plumbing", "electrical", "unknown"]) {
    for (const fields of [null, undefined, {}, [], "raw", { ownerPhone: "secret" }]) {
      assert.deepEqual(renderableTypeFields(jobType, fields), []);
    }
  }
});
