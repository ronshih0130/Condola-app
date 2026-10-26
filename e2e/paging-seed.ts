import { query } from "../src/server/db";
import { ORG_ID } from "../src/server/ids";

/** More than a 40-row cap and more than the 50-row page. */
export const PAGING_COUNT = 55;

export async function seedPagingRows(prefix: string) {
  await query(
    `WITH props AS (
       INSERT INTO properties (org_id, name, country_code, currency, timezone, default_rental_mode, created_at)
       SELECT $1, $2 || '-p-' || lpad(i::text, 3, '0'), 'TW', 'TWD', 'Asia/Taipei', 'whole_unit',
              timestamp '2000-01-01' + make_interval(mins => i)
         FROM generate_series(0, $3::int) AS i
       RETURNING id, created_at
     ),
     numbered_props AS (
       SELECT id, created_at, (row_number() OVER (ORDER BY created_at) - 1)::int AS i FROM props
     ),
     units AS (
       INSERT INTO units (org_id, property_id, label, rental_mode, created_at)
       SELECT $1, id, '1F', 'whole_unit', created_at FROM numbered_props
       RETURNING id, property_id, created_at
     ),
     numbered_units AS (
       SELECT id AS unit_id, property_id, created_at, (row_number() OVER (ORDER BY created_at) - 1)::int AS i FROM units
     ),
     people AS (
       INSERT INTO contacts (org_id, is_tenant, display_name, created_at)
       SELECT $1, true, $2 || '-t-' || lpad(i::text, 3, '0'), timestamp '2000-01-01' + make_interval(mins => i)
         FROM generate_series(0, $3::int - 1) AS i
       RETURNING id, created_at
     ),
     numbered_people AS (
       SELECT id, (row_number() OVER (ORDER BY created_at) - 1)::int AS i FROM people
     ),
     created AS (
       INSERT INTO leases (
         org_id, property_id, unit_id, target_unit_id, status, start_date, end_date,
         currency, rent_amount_minor, deposit_amount_minor, deposit_months, created_at
       )
       SELECT $1, u.property_id, u.unit_id, u.unit_id, 'draft', '2026-01-01', '2026-12-31',
              'TWD', 1000000, 0, 0, u.created_at
         FROM numbered_units u
       RETURNING id, created_at
     ),
     numbered_leases AS (
       SELECT id, (row_number() OVER (ORDER BY created_at) - 1)::int AS i FROM created
     )
     INSERT INTO lease_parties (org_id, lease_id, contact_id, role)
     SELECT $1, l.id, p.id, 'primary'
       FROM numbered_leases l
       JOIN numbered_people p ON p.i = CASE WHEN l.i < $3::int THEN l.i ELSE 0 END`,
    [ORG_ID, prefix, PAGING_COUNT],
  );
}

export async function clearPagingRows(prefix: string) {
  const like = `${prefix}%`;
  await query(
    `DELETE FROM lease_parties
      WHERE lease_id IN (
        SELECT l.id FROM leases l
          JOIN properties p ON p.id = l.property_id
         WHERE p.org_id = $1 AND p.name LIKE $2
      )`,
    [ORG_ID, like],
  );
  await query(
    `DELETE FROM leases
      WHERE property_id IN (SELECT id FROM properties WHERE org_id = $1 AND name LIKE $2)`,
    [ORG_ID, like],
  );
  await query(
    `DELETE FROM units
      WHERE property_id IN (SELECT id FROM properties WHERE org_id = $1 AND name LIKE $2)`,
    [ORG_ID, like],
  );
  await query(`DELETE FROM properties WHERE org_id = $1 AND name LIKE $2`, [ORG_ID, like]);
  await query(`DELETE FROM contacts WHERE org_id = $1 AND display_name LIKE $2`, [ORG_ID, like]);
}
