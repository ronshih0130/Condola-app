-- Read-only inventory, including counts and up to twenty sample ids per org/finding.
WITH basis AS (
  SELECT l.*,
    rent_amount_minor::numeric /
      CASE rent_frequency::text WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END AS monthly
  FROM public.leases l
), flagged AS (
  SELECT b.org_id, b.id, f.finding
  FROM basis b
  CROSS JOIN LATERAL (
    VALUES
      ('zero_rent_positive_deposit', monthly = 0 AND deposit_amount_minor > 0),
      ('amount_months_mismatch', deposit_months IS NOT NULL AND monthly > 0
        AND deposit_amount_minor IS DISTINCT FROM
          CASE WHEN currency = 'TWD' THEN round(monthly * deposit_months / 100) * 100
               ELSE round(monthly * deposit_months) END),
      ('over_two_without_reason',
        coalesce(deposit_months, deposit_amount_minor::numeric / nullif(monthly, 0), 0) > 2
        AND btrim(coalesce(deposit_override_reason, '')) = ''),
      ('partial_override',
        (btrim(coalesce(deposit_override_reason, '')) <> ''
          OR deposit_overridden_by IS NOT NULL OR deposit_overridden_at IS NOT NULL)
        AND NOT (btrim(coalesce(deposit_override_reason, '')) <> ''
          AND deposit_overridden_by IS NOT NULL AND deposit_overridden_at IS NOT NULL))
  ) f(finding, matches)
  WHERE f.matches
)
SELECT org_id, finding, count(*) AS affected_count,
  (array_agg(id ORDER BY id))[1:20] AS sample_ids,
  array_agg(id ORDER BY id) AS affected_ids
FROM flagged
GROUP BY org_id, finding
ORDER BY org_id, finding;
