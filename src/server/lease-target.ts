import type { Client } from "pg";
import { maybe } from "./db";
import { FlowError } from "./errors";

/** Fresh creates only. Discovery is not authoritative; lock and reread each ancestor. */
export async function lockFreshLeaseTarget(client: Client, orgId: string, targetId: string) {
  const candidate = await maybe<{ unit_id: string; property_id: string; kind: string }>(client,
    `SELECT unit_id::text, property_id::text, kind FROM (
       SELECT u.id AS unit_id, u.property_id, 'room'::text AS kind, 0 AS rank
         FROM rooms r JOIN units u ON u.id=r.unit_id AND u.org_id=r.org_id
         JOIN properties p ON p.id=u.property_id AND p.org_id=u.org_id
        WHERE r.id=$1 AND r.org_id=$2 AND r.archived_at IS NULL
          AND u.archived_at IS NULL AND p.archived_at IS NULL AND u.rental_mode='by_room'
       UNION ALL
       SELECT u.id, u.property_id, 'whole_unit'::text, 1
         FROM units u JOIN properties p ON p.id=u.property_id AND p.org_id=u.org_id
        WHERE u.id=$1 AND u.org_id=$2 AND u.archived_at IS NULL
          AND p.archived_at IS NULL AND u.rental_mode='whole_unit'
     ) targets ORDER BY rank LIMIT 1`, [targetId, orgId]);
  if (!candidate) throw new FlowError("errors.notFound");
  const property = await maybe<{ id: string; currency: string }>(client,
    `SELECT id::text, currency FROM properties WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE`,
    [candidate.property_id, orgId]);
  if (!property) throw new FlowError("errors.notFound");
  const unit = await maybe<{ id: string; property_id: string; rental_mode: string; label: string }>(client,
    `SELECT id::text, property_id::text, rental_mode::text, label FROM units
      WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE`, [candidate.unit_id, orgId]);
  if (!unit || unit.property_id !== property.id || unit.rental_mode !== (candidate.kind === "room" ? "by_room" : "whole_unit")) {
    throw new FlowError("errors.notFound");
  }
  if (candidate.kind === "whole_unit") {
    return { id: unit.id, unit_id: unit.id, property_id: property.id, currency: property.currency, kind: candidate.kind, label: unit.label };
  }
  const room = await maybe<{ id: string; unit_id: string; label: string }>(client,
    `SELECT id::text, unit_id::text, label FROM rooms WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE`,
    [targetId, orgId]);
  if (!room || room.unit_id !== unit.id) throw new FlowError("errors.notFound");
  return { id: room.id, unit_id: unit.id, property_id: property.id, currency: property.currency, kind: candidate.kind, label: room.label };
}
