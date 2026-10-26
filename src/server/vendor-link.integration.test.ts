import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { svc, tx } from "./db";
import { createTicket } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { ticketPhotoPath } from "./repair-rules";
import type { Session } from "./types";
import {
  __setVendorLinkKillSwitchForTests,
  confirmVendorPhoto,
  dispatchVendor,
  loadVendorJob,
  prepareVendorPhoto,
  revokeVendorJob,
  submitVendorReport,
} from "./vendor-repair";

function staff(userId: string, orgId = ORG_ID): Session {
  return {
    userId, orgId, liveOrgId: orgId,
    sessionId: "vendor-link", email: "staff@demo", name: "Staff",
    kind: "staff", role: "admin", environment: "live",
    locale: "zh-TW", calendar: "gregorian", leaseId: null,
  };
}

function tenant(): Session {
  return {
    ...staff(USERS.tenant2),
    kind: "tenant", role: null, email: "tenant@demo", name: "租客",
  };
}

function notFound(error: unknown) {
  return error instanceof FlowError && error.key === "errors.notFound";
}

function tokenOf(url: string) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/v\//, ""));
}

describe("vendor link gating", { concurrency: false }, () => {
  test("legacy behavior, terminal states, revocation and ticket isolation", async () => {
    const title = `vendor-link-${randomUUID()}`;
    const vendorName = `v-${randomUUID()}`;
    const tickets: string[] = [];
    const admin = staff(USERS.admin);
    const saved = await svc(null, (client) =>
      client.query<{ feature_flags: string | null }>(
        `SELECT feature_flags::text FROM organizations WHERE id = $1`,
        [ORG_ID],
      ),
    );
    assert.equal(saved.rowCount, 1);
    const lease = await tx(USERS.admin, (client) =>
      client.query<{ id: string }>(
        `SELECT l.id::text
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id
           JOIN contacts c ON c.id = lp.contact_id
          WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active'
          ORDER BY l.created_at LIMIT 1`,
        [USERS.tenant2, ORG_ID],
      ),
    );
    assert.ok(lease.rows[0]);
    async function flags(enabled: boolean | null) {
      await svc(null, (client) => client.query(
        `UPDATE organizations
            SET feature_flags = (coalesce(feature_flags, '{}'::jsonb) - 'vendor_link')
                || CASE WHEN $2::boolean IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object('vendor_link', $2::boolean) END
          WHERE id = $1`,
        [ORG_ID, enabled],
      ));
    }
    async function issue(suffix: string) {
      const ticketId = await createTicket(tenant(), {
        leaseId: lease.rows[0].id, category: "plumbing",
        title: `${title}-${suffix}`, description: "Shared repair",
      });
      tickets.push(ticketId);
      const issued = await dispatchVendor(admin, ticketId, {
        vendorName, vendorPhone: "0912000111", vendorTrade: "plumbing", contactWindow: "Monday",
      }, "http://127.0.0.1:43123");
      return { ...issued, ticketId, token: tokenOf(issued.url) };
    }
    async function rejectsWrites(job: { token: string; ticketId: string }) {
      await assert.rejects(() => submitVendorReport(job.token, { done: true, cost: "100" }), notFound);
      await assert.rejects(() => prepareVendorPhoto(job.token, {
        fileName: "repair.jpg", mime: "image/jpeg", size: 4,
      }), notFound);
      await assert.rejects(() => confirmVendorPhoto(job.token, {
        path: ticketPhotoPath(ORG_ID, job.ticketId, randomUUID(), "image/jpeg"),
        fileName: "repair.jpg", mime: "image/jpeg", size: 4, uploadToken: "",
      }), notFound);
    }
    try {
      // Default kill switch remains OFF even when the organization opts in.
      await flags(true);
      const legacy = await issue("off");
      const legacyPage = await loadVendorJob(legacy.token);
      assert.ok(legacyPage);
      assert.equal(Object.hasOwn(legacyPage, "vendorLink"), false);
      await submitVendorReport(legacy.token, { done: true, cost: "100" });
      await submitVendorReport(legacy.token, { done: true, cost: "999" });
      const legacyResult = await svc(null, (client) => client.query<{
        status: string; cost: string;
      }>(
        `SELECT t.status::text, j.reported_cost_minor::text AS cost
           FROM maintenance_tickets t
           JOIN repair_vendor_jobs j ON j.ticket_id = t.id AND j.org_id = t.org_id
          WHERE t.id = $1 AND t.org_id = $2 AND j.id = $3`,
        [legacy.ticketId, ORG_ID, legacy.jobId],
      ));
      assert.deepEqual(legacyResult.rows[0], { status: "resolved", cost: "10000" });

      __setVendorLinkKillSwitchForTests(true);
      await flags(null);
      const absent = await issue("absent");
      const absentPage = await loadVendorJob(absent.token);
      assert.ok(absentPage);
      assert.equal(Object.hasOwn(absentPage, "vendorLink"), false);
      await submitVendorReport(absent.token, { done: true, cost: "100" });

      await flags(true);
      for (const status of ["closed", "cancelled"]) {
        const job = await issue(status);
        const page = await loadVendorJob(job.token);
        assert.equal(page?.vendorLink?.capability, "write");
        assert.deepEqual(page?.vendorLink?.typeFields, []);
        await svc(null, (client) => client.query(
          `UPDATE maintenance_tickets SET status = $3::ticket_status WHERE id = $1 AND org_id = $2`,
          [job.ticketId, ORG_ID, status],
        ));
        assert.equal((await loadVendorJob(job.token))?.vendorLink?.capability, "read_only");
        await rejectsWrites(job);
        const untouched = await svc(null, (client) => client.query(
          `SELECT reported_at, reported_cost_minor FROM repair_vendor_jobs WHERE id = $1 AND org_id = $2`,
          [job.jobId, ORG_ID],
        ));
        assert.deepEqual(untouched.rows[0], { reported_at: null, reported_cost_minor: null });
      }

      const revoked = await issue("revoked");
      await revokeVendorJob(admin, revoked.ticketId, revoked.jobId);
      assert.equal(await loadVendorJob(revoked.token), null);
      await rejectsWrites(revoked);

      const own = await issue("own");
      const other = await issue("other");
      await assert.rejects(() => dispatchVendor(staff(USERS.coastAdmin, ORG2_ID), own.ticketId, {
        vendorName, vendorPhone: "0912000111", vendorTrade: "plumbing", contactWindow: "Monday",
      }, "http://127.0.0.1:43123"), notFound);
      // Token APIs accept no target ID; prove mutation is bound to the token's own ticket.
      await submitVendorReport(own.token, { done: true, cost: "200" });
      const isolation = await svc(null, (client) => client.query<{
        id: string; status: string; reported: boolean;
      }>(
        `SELECT t.id::text, t.status::text, j.reported_at IS NOT NULL AS reported
           FROM maintenance_tickets t
           JOIN repair_vendor_jobs j ON j.ticket_id = t.id AND j.org_id = t.org_id
          WHERE t.id = ANY($1::uuid[]) AND t.org_id = $2`,
        [[own.ticketId, other.ticketId], ORG_ID],
      ));
      const byId = new Map(isolation.rows.map((row) => [row.id, row]));
      assert.equal(byId.get(own.ticketId)?.status, "resolved");
      assert.equal(byId.get(own.ticketId)?.reported, true);
      assert.equal(byId.get(other.ticketId)?.status, "assigned");
      assert.equal(byId.get(other.ticketId)?.reported, false);
      assert.equal((await loadVendorJob(own.token))?.vendorLink?.capability, "write");
    } finally {
      __setVendorLinkKillSwitchForTests(false);
      try {
        await svc(null, (client) => client.query(
          `UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`,
          [ORG_ID, saved.rows[0].feature_flags],
        ));
      } finally {
        await svc(null, async (client) => {
          if (tickets.length) {
            await client.query(`DELETE FROM repair_vendor_jobs WHERE org_id = $1 AND ticket_id = ANY($2::uuid[])`, [
              ORG_ID, tickets,
            ]);
            await client.query(`DELETE FROM maintenance_tickets WHERE org_id = $1 AND id = ANY($2::uuid[])`, [
              ORG_ID, tickets,
            ]);
          }
          await client.query(`DELETE FROM contacts WHERE org_id = $1 AND is_vendor AND display_name = $2`, [
            ORG_ID, vendorName,
          ]);
        });
      }
    }
  });
});
