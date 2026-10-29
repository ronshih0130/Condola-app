CREATE FUNCTION public.tenant_payee_account(p_lease uuid)
RETURNS TABLE (
  bank_account_id uuid,
  holder_name text,
  bank_name text,
  bank_code text,
  branch_code text,
  account_number text,
  account_last5 text,
  is_owner_account boolean,
  details jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_lease record;
  v_account record;
  v_found boolean := false;
BEGIN
  -- current_user is the function owner inside SECURITY DEFINER. The role
  -- setting preserves the caller's SET ROLE context; session_user covers
  -- connections made directly as authenticated.
  IF v_user_id IS NULL
     OR current_setting('request.jwt.claim.role', true)
          IS DISTINCT FROM 'authenticated'
     OR coalesce(
          nullif(current_setting('role', true), 'none'),
          session_user::text
        ) IS DISTINCT FROM 'authenticated'
  THEN
    RAISE EXCEPTION 'authenticated tenant context required'
      USING ERRCODE = '42501';
  END IF;

  SELECT l.org_id, l.status, l.end_date, l.payee_bank_account_id
  INTO v_lease
  FROM public.leases AS l
  WHERE l.id = p_lease;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_lease.status = 'active'
     AND (v_lease.end_date IS NULL OR v_lease.end_date >= current_date)
     AND EXISTS (
       SELECT 1
       FROM public.lease_parties AS lp
       JOIN public.contacts AS c
         ON c.org_id = lp.org_id AND c.id = lp.contact_id
       WHERE lp.org_id = v_lease.org_id
         AND lp.lease_id = p_lease
         AND c.user_id = v_user_id
         AND c.is_tenant
         AND c.archived_at IS NULL
     )
  THEN
    SELECT b.id AS bank_account_id,
           b.holder_name,
           b.bank_name,
           b.bank_code,
           b.branch_code,
           n.account_number,
           b.account_last5::text AS account_last5,
           b.owner_contact_id IS NOT NULL AS is_owner_account,
           b.details
    INTO v_account
    FROM public.bank_accounts AS b
    LEFT JOIN public.payee_account_numbers AS n
      ON n.org_id = b.org_id AND n.bank_account_id = b.id
    WHERE b.org_id = v_lease.org_id
      AND b.archived_at IS NULL
      AND b.show_to_tenants
      AND (
        (v_lease.payee_bank_account_id IS NOT NULL
          AND b.id = v_lease.payee_bank_account_id)
        OR
        (v_lease.payee_bank_account_id IS NULL
          AND b.is_default_payee
          AND b.owner_contact_id IS NULL)
      )
    ORDER BY b.id
    LIMIT 1;

    v_found := FOUND;
  END IF;

  INSERT INTO public.audit_log (
    org_id, actor_user_id, actor_role, table_name, row_id, action,
    old_row, new_row, changed_cols, reason
  )
  VALUES (
    v_lease.org_id,
    v_user_id,
    current_user,
    'payee_account_numbers',
    CASE WHEN v_found THEN v_account.bank_account_id::text ELSE p_lease::text END,
    'select'::public.audit_action,
    NULL,
    jsonb_build_object(
      'lease_id', p_lease,
      'result', CASE WHEN v_found THEN 'one' ELSE 'none' END,
      'account_last5', CASE WHEN v_found THEN v_account.account_last5 ELSE NULL END
    ),
    NULL,
    'tenant_payee_read'
  );

  IF v_found THEN
    RETURN QUERY
    SELECT v_account.bank_account_id,
           v_account.holder_name,
           v_account.bank_name,
           v_account.bank_code,
           v_account.branch_code,
           v_account.account_number,
           v_account.account_last5::text,
           v_account.is_owner_account,
           v_account.details;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_payee_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_payee_account(uuid) TO authenticated;
