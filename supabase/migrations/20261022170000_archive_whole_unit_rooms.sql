-- Version 20261022170000.
-- Whole-unit saves used to insert rooms A/B/C. Those rooms were offered as
-- leasable, then fn_lease_target_guard rejected the lease. Archive them when
-- no lease points at the room.
--
-- Archive, do not delete. A meter, charge, or other child can still reference
-- the row, and deleting would fail or cascade. UNIQUE (unit_id, label) keeps
-- the label reserved; whole-unit saves no longer insert rooms, so that is safe.
-- A room that already has a lease (including an ended one) stays in place so
-- that contract can still be read. New leases use the unit, not these rooms.

UPDATE rooms r
   SET archived_at = coalesce(r.archived_at, now()),
       updated_at = now()
  FROM units u
 WHERE u.id = r.unit_id
   AND u.rental_mode = 'whole_unit'
   AND r.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.target_room_id = r.id);
