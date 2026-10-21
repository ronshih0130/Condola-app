import assert from "node:assert/strict";
import test from "node:test";
import { authEmailTaken, portalLoginEmail } from "./portal-login";

test("a sandbox firm or a taken email mints a new portal login", () => {
  assert.equal(
    portalLoginEmail({ environment: "sandbox", contactEmail: "shared@example.com", emailTaken: false }),
    null,
  );
  assert.equal(
    portalLoginEmail({ environment: "live", contactEmail: "shared@example.com", emailTaken: true }),
    null,
  );
  assert.equal(portalLoginEmail({ environment: "live", contactEmail: null, emailTaken: false }), null);
  assert.equal(
    portalLoginEmail({ environment: "live", contactEmail: "free@example.com", emailTaken: false }),
    "free@example.com",
  );
  assert.equal(
    portalLoginEmail({ environment: "live", contactEmail: "  Free@Example.com ", emailTaken: false }),
    "free@example.com",
  );
});

test("only an auth email collision counts as a taken login", () => {
  assert.equal(authEmailTaken(Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: "23505" })), true);
  assert.equal(
    authEmailTaken(new Error('duplicate key value violates unique constraint "contacts_org_tenant_email_uniq"')),
    false,
  );
  assert.equal(authEmailTaken(new Error("permission denied for table users")), false);
});
