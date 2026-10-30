import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VENDOR_LINK_ENABLED,
  renderableTypeFields,
  vendorLinkCapability,
  vendorLinkOn,
  vendorLinkSafeView,
} from "./vendor-link-rules";

test("vendor_link requires both explicit switches", () => {
  assert.equal(VENDOR_LINK_ENABLED, false);
  const flags: Array<[unknown, boolean]> = [
    [undefined, false], [null, false], [false, false], [true, false],
    ["true", false], [1, false], [[], false], [{}, false],
    [{ vendor_link: null }, false], [{ vendor_link: false }, false],
    [{ vendor_link: "false" }, false], [{ vendor_link: 1 }, false],
    [{ vendor_link: "TRUE" }, false], [{ vendor_link: " true" }, false],
    [{ vendor_link: {} }, false], [{ vendor_link: [] }, false],
    [{ vendor_link: true }, true], [{ vendor_link: "true" }, true],
  ];
  for (const [value, enabled] of flags) {
    assert.equal(vendorLinkOn(false, value), false);
    assert.equal(vendorLinkOn(true, value), enabled);
  }
  assert.equal(vendorLinkOn("true" as unknown as boolean, { vendor_link: true }), false);
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
