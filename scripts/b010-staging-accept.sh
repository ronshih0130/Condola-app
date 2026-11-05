#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

: "${OUT:?Set OUT to an evidence directory}"
mkdir -p "$OUT"
command -v jq >/dev/null
SQL=/workspace/e2e/sql.sh
ORG=961b353f-7dac-43d9-9ff7-19eb1ceb5b84
LIVE=161871b3-1041-44c9-aa10-e4812cc9a4c9
failed=0
declare -a names=() statuses=()
declare -a jobs=()
trap 'for p in "${jobs[@]}"; do wait "$p" 2>/dev/null || true; done' EXIT

now_ms() { date +%s%3N; }

# Emit only sanitized SQLSTATEs and timings. HTTPS response bodies can contain
# recipient data or session identifiers and are never printed or persisted.
request() {
  local sql=$1 destination=$2 started response rc=0
  started=$(now_ms)
  response=$(bash "$SQL" "$sql" 2>/dev/null) || rc=$?
  if ! jq -e . >/dev/null 2>&1 <<<"$response"; then
    jq -n --argjson elapsed "$(( $(now_ms)-started ))" \
      '{ok:false,code:"TRANSPORT",elapsed_ms:$elapsed}' >"$destination"
    return
  fi
  jq --argjson elapsed "$(( $(now_ms)-started ))" --argjson rc "$rc" '
    [.. | objects | select(.b010_accept == true)] as $r |
    if ($r|length)==1 and $rc==0 then
      {ok:$r[0].ok,code:$r[0].code,
       sql_elapsed_ms:$r[0].sql_elapsed_ms,elapsed_ms:$elapsed}
    else {ok:false,code:"UNCLASSIFIED_RESPONSE",elapsed_ms:$elapsed} end
  ' <<<"$response" >"$destination"
}

# An exception subtransaction converts database errors into SQLSTATE evidence.
# All mutations, including the temporary session, remain inside ROLLBACK.
wrap() {
  local body=$1
  cat <<SQL
BEGIN;
SET LOCAL statement_timeout='14s';
SET LOCAL lock_timeout='10s';
CREATE TEMP TABLE b010_accept_result(ok boolean,code text,sql_elapsed_ms numeric);
DO \$accept\$
DECLARE
  started timestamptz:=clock_timestamp();
  actor uuid; sess uuid:=gen_random_uuid(); actor_role text;
  payment uuid; payment_lease uuid; payment_status text;
  invoice uuid; reminder_lease uuid; event uuid; n integer;
BEGIN
  BEGIN
    $body
    INSERT INTO b010_accept_result VALUES(true,'00000',
      extract(epoch FROM clock_timestamp()-started)*1000);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO b010_accept_result VALUES(false,SQLSTATE,
      extract(epoch FROM clock_timestamp()-started)*1000);
  END;
END \$accept\$;
SELECT json_build_object('b010_accept',true,'ok',ok,'code',code,
  'sql_elapsed_ms',sql_elapsed_ms) AS evidence FROM b010_accept_result;
ROLLBACK;
SQL
}

setup="
SELECT m.user_id,m.role::text INTO STRICT actor,actor_role
FROM public.org_members m
WHERE m.org_id='$LIVE' AND m.status='active' AND m.role IN ('admin','manager')
ORDER BY m.id LIMIT 1;
INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at)
VALUES(sess,actor,gen_random_uuid()::text,clock_timestamp()+interval '1 hour');
PERFORM set_config('request.jwt.claim.sub',actor::text,true);
SELECT p.id,p.lease_id,p.status::text INTO STRICT payment,payment_lease,payment_status
FROM public.payments p WHERE p.org_id='$ORG'
AND p.status IN ('submitted','confirmed') ORDER BY p.id LIMIT 1;
IF NOT EXISTS (
  SELECT 1 FROM public.organizations o
  WHERE o.id='$ORG' AND o.environment='sandbox' AND o.live_org_id='$LIVE'
  AND o.feature_flags->'payment_results_v2'='true'::jsonb
  AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
) OR (SELECT count(*) FROM public.platform_settings f
  WHERE f.key IN ('payment_results_v2','rent_reminders_v2')
  AND f.value->'enabled'='true'::jsonb
  AND f.value->'allowed_org_ids' @> jsonb_build_array('$ORG'))<>2 THEN
  RAISE EXCEPTION 'Flags prerequisite missing' USING ERRCODE='P0001';
END IF;
"

context="
IF NOT app.b010_lock_payment_context('$ORG','$LIVE','sandbox',
  sess,payment_lease,actor_role) THEN
  RAISE EXCEPTION 'Context disabled';
END IF;
"

transition="
UPDATE public.payments SET
 status=CASE WHEN payment_status='submitted' THEN 'rejected' ELSE 'reversed' END,
 rejected_reason=CASE WHEN payment_status='submitted'
   THEN 'b010 acceptance rollback' ELSE rejected_reason END
WHERE id=payment AND org_id='$ORG';
GET DIAGNOSTICS n=ROW_COUNT;
IF n<>1 THEN RAISE EXCEPTION 'Payment fixture missing'; END IF;
"

record() {
  local name=$1 predicate=$2
  names+=("$name")
  if jq -e "$predicate" "$OUT/$name.json" >/dev/null; then
    statuses+=("PASS")
  else
    statuses+=("FAIL")
    failed=1
  fi
}

# Writer drain is read-only and precedes every scenario.
request "$(wrap "
IF EXISTS (
 SELECT 1 FROM pg_stat_activity
 WHERE pid<>pg_backend_pid() AND datname=current_database()
 AND state<>'idle'
 AND query ~* '(payments|email_log)'
) THEN RAISE EXCEPTION 'Writers not drained'; END IF;
")" "$OUT/drain.json"
record drain '.ok == true'
if (( failed )); then
  printf '%-25s %s\n' SCENARIO RESULT drain FAIL
  exit 1
fi

reminder="
SELECT i.id,i.lease_id INTO STRICT invoice,reminder_lease
FROM public.invoices i JOIN public.leases l ON l.id=i.lease_id AND l.org_id=i.org_id
WHERE i.org_id='$ORG' AND l.status='active' AND l.terminated_on IS NULL
AND i.status IN ('open','partially_paid') AND i.balance_minor>0
AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id
  AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0)
AND EXISTS (SELECT 1 FROM public.lease_parties lp
 JOIN public.contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
 WHERE lp.org_id=i.org_id AND lp.lease_id=i.lease_id
 AND lp.role IN ('primary','co_tenant') AND c.archived_at IS NULL
 AND c.email IS NOT NULL AND btrim(c.email::text)<>'')
AND NOT EXISTS (SELECT 1 FROM public.email_log e WHERE e.org_id=i.org_id
 AND e.target_id=i.id AND e.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
ORDER BY i.id LIMIT 1;
event:=app.b010_manual_reminder('$ORG','$LIVE','sandbox',sess,
 reminder_lease,invoice,gen_random_uuid());
SELECT count(*) INTO n FROM app.b028_claim_manual('$ORG','$LIVE',
 'sandbox',sess,reminder_lease,event,'{}'::uuid[]);
IF n<1 THEN RAISE EXCEPTION 'No reminder claim'; END IF;
"

request "$(wrap "$setup $context $transition $reminder")" "$OUT/S1.json"
record S1 '.ok == true'

# Prove holder readiness through pg_locks rather than assuming that an HTTPS
# request has reached PostgreSQL after a fixed network delay.
wait_holder() {
  local tag=$1 ready
  for ((attempt=0;attempt<25;attempt++)); do
    ready=$(bash "$SQL" "SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
      WHERE a.application_name='$tag' AND l.granted
      AND l.relation='public.platform_settings'::regclass
      AND l.mode='ShareRowExclusiveLock') AS b010_holder_ready;" 2>/dev/null) || ready='{}'
    if jq -e '[..|objects|select(.b010_holder_ready==true)]|length>0' \
      >/dev/null 2>&1 <<<"$ready"; then return 0; fi
    sleep 0.1
  done
  return 1
}

holder_body="
LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE;
PERFORM 1 FROM public.organizations WHERE id='$ORG' FOR UPDATE;
"

for specification in S2:8 S3:2; do
  name=${specification%:*}
  seconds=${specification#*:}
  tag="b010_accept_${name}_$$"
  holder_sql=$(wrap "PERFORM set_config('application_name','$tag',true);
    $holder_body PERFORM pg_sleep($seconds);")
  request "$holder_sql" "$OUT/$name-holder.json" &
  pid=$!; jobs+=("$pid")
  if wait_holder "$tag"; then
    request "$(wrap "$setup $context $transition")" "$OUT/$name.json"
  else
    jq -n '{ok:false,code:"HOLDER_NOT_READY",elapsed_ms:0}' >"$OUT/$name.json"
  fi
  wait "$pid"
  if [[ $name == S2 ]]; then
    record "$name" '.ok == false and .code == "55P03"
      and .sql_elapsed_ms >= 5900 and .sql_elapsed_ms < 7200'
  else
    record "$name" '.ok == true and .sql_elapsed_ms >= 500
      and .sql_elapsed_ms < 7000'
  fi
  if ! jq -e '.ok == true' "$OUT/$name-holder.json" >/dev/null; then
    statuses[${#statuses[@]}-1]=FAIL
    failed=1
  fi
done

# A preholds the payment tuple to force an actual inversion: B holds the
# organization/lease, then waits for that tuple while A polls for context.
tag="b010_accept_S4_B_$$"
a_tag="b010_accept_S4_A_$$"
a_body="$setup
PERFORM set_config('application_name','$a_tag',true);
PERFORM 1 FROM public.payments WHERE id=payment FOR UPDATE;
PERFORM pg_sleep(2);
$context
$transition"
request "$(wrap "$a_body")" "$OUT/S4-A.json" &
apid=$!; jobs+=("$apid")

a_ready=false
for ((attempt=0;attempt<25;attempt++)); do
  response=$(bash "$SQL" "SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
    WHERE a.application_name='$a_tag' AND l.granted
    AND l.relation='public.payments'::regclass
    AND l.mode='RowShareLock') AS b010_a_ready;" 2>/dev/null) || response='{}'
  if jq -e '[..|objects|select(.b010_a_ready==true)]|length>0' \
    >/dev/null 2>&1 <<<"$response"; then a_ready=true; break; fi
  sleep 0.1
done

if $a_ready; then
  b_body="
  PERFORM set_config('application_name','$tag',true);
  PERFORM 1 FROM public.organizations WHERE id IN ('$ORG','$LIVE') ORDER BY id FOR UPDATE;
  SELECT p.id,p.lease_id INTO STRICT payment,payment_lease FROM public.payments p
    WHERE p.org_id='$ORG' AND p.status IN ('submitted','confirmed') ORDER BY p.id LIMIT 1;
  PERFORM 1 FROM public.leases WHERE id=payment_lease AND org_id='$ORG' FOR UPDATE;
  LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE;
  PERFORM 1 FROM public.payments WHERE id=payment FOR UPDATE;
  "
  request "$(wrap "$b_body")" "$OUT/S4-B.json" &
  bpid=$!; jobs+=("$bpid")
  wait "$bpid"
else
  jq -n '{ok:false,code:"A_NOT_READY",elapsed_ms:0}' >"$OUT/S4-B.json"
fi
wait "$apid"
jq -s '{
  ok:(.[0].code=="55P03" and .[0].sql_elapsed_ms>=5900
      and .[0].sql_elapsed_ms<7200 and .[1].ok==true),
  elapsed_ms:([.[].elapsed_ms]|max),
  a:.[0],b:.[1]
}' "$OUT/S4-A.json" "$OUT/S4-B.json" >"$OUT/S4.json"
record S4 '.ok == true and .a.code != "40P01" and .b.code != "40P01"'

jq -n '{status:"DEFERRED",owner:"harness",description:"Flags-OFF verification after rollback"}' \
  >"$OUT/S5.json"
names+=("S5"); statuses+=("HARNESS")
printf '%-25s %s\n' SCENARIO RESULT
for i in "${!names[@]}"; do
  printf '%-25s %s\n' "${names[$i]}" "${statuses[$i]}"
done
exit "$failed"
