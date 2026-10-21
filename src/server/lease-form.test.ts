import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError, mapDbError } from "./errors";
import { leaseInputFromForm } from "./lease-form";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

test("the lease form keeps a new tenant and an existing contact id apart", () => {
  const created = leaseInputFromForm(
    form({
      tenantMode: "new",
      tenantName: "新租客",
      tenantPhone: "0912000000",
      tenantEmail: "a@example.com",
    }),
  );
  assert.equal(created.tenantContactId, "");
  assert.equal(created.tenantName, "新租客");
  assert.equal(created.tenantEmail, "a@example.com");

  const id = "11111111-1111-4111-8111-111111111111";
  const existing = leaseInputFromForm(form({ tenantMode: id, tenantName: "", tenantPhone: "", tenantEmail: "other@example.com" }));
  assert.equal(existing.tenantContactId, id);

  assert.equal(leaseInputFromForm(form({})).tenantContactId, "");
});

test("a second tenant contact with the same email is the existing-tenant error", () => {
  const mapped = mapDbError(new Error('duplicate key value violates unique constraint "contacts_org_tenant_email_uniq"'));
  assert.ok(mapped instanceof FlowError);
  assert.equal(mapped.key, "errors.tenantExists");
});

test("the lease wizard can search for an existing tenant", () => {
  const wizard = readFileSync(new URL("../components/lease-wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, /data-testid="tenant-mode-new"/);
  assert.match(wizard, /data-testid="tenant-mode-existing"/);
  assert.match(wizard, /data-testid="tenant-search"/);
  assert.match(wizard, /data-testid="tenant-option"/);
  assert.match(wizard, /i_existing_tenant/);
  assert.match(wizard, /filterTenants/);
  assert.equal(wizard.includes("房東"), false);
  assert.equal(wizard.includes("房客"), false);
});
