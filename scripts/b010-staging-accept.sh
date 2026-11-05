#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

: "${OUT:?Set OUT to an evidence directory}"
mkdir -p "$OUT"
command -v jq >/dev/null
SQL=/workspace/e2e/sql.sh
RO=/workspace/e2e/stgro.sh
ORG=961b353f-7dac-43d9-9ff7-19eb1ceb5b84
LIVE=161871b3-1041-44c9-aa10-e4812cc9a4c9
S4_TRANSACTION_BOUND_MS=16000
failed=0
declare -a names=() statuses=() jobs=()
trap 'for p in "${jobs[@]}"; do wait "$p" 2>/dev/null || true; done' EXIT

now_ms() { date +%s%3N; }

# Never print or persist raw HTTPS response bodies.
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

wrap() {
  local body=$1
  cat <<SQL
BEGIN;
SET LOCAL statement_timeout='17s';
SET LOCAL lock_timeout='10s';
CREATE TEMP TABLE b010_accept_result(ok boolean,code text,sql_elapsed_ms numeric);
DO \$accept\$
DECLARE
  started timestamptz:=clock_timestamp();
  actor uuid; sess uuid:=gen_random_uuid(); actor_role text;
  payment uuid; payment_lease uuid; payment_status text;
  invoice uuid; reminder_lease uuid; event uuid; n integer;
  fixture_date date;
  gate_deadline timestamptz;
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
  AND jsonb_typeof(f.value->'allowed_org_ids')='array'
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
 status=(CASE WHEN payment_status='submitted'
   THEN 'rejected' ELSE 'reversed' END)::public.payment_status,
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

failure() {
  jq -n --arg code "$2" \
    '{ok:false,code:$code,elapsed_ms:0}' >"$OUT/$1.json"
}

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

# S1-only changes stay in its rollback transaction and target this sandbox.
# Reuse an existing rule rather than guessing undocumented required columns.
# Do not change feature flags or platform settings.
fixture="
IF NOT EXISTS (
 SELECT 1 FROM public.reminder_rules r
 WHERE r.org_id='$ORG' AND r.event_type='rent_overdue'
) THEN
 RAISE EXCEPTION 'Reminder rule fixture missing' USING ERRCODE='B1001';
END IF;
UPDATE public.reminder_rules
SET is_enabled=true,
 channels=CASE WHEN 'email'=ANY(channels) THEN channels
               ELSE array_append(channels,'email') END
WHERE org_id='$ORG' AND event_type='rent_overdue';

UPDATE public.organizations
SET settings=jsonb_set(
 coalesce(settings,'{}'::jsonb),
 '{email_tenant_rent_overdue}','true'::jsonb,true)
WHERE id='$ORG' AND environment='sandbox' AND live_org_id='$LIVE';
GET DIAGNOSTICS n=ROW_COUNT;
IF n<>1 THEN
 RAISE EXCEPTION 'Reminder organization fixture missing' USING ERRCODE='B1002';
END IF;

invoice:=gen_random_uuid();
reminder_lease:='82cb63ae-b878-4a98-ae51-f5ac02702838'::uuid;
SELECT (clock_timestamp() AT TIME ZONE o.timezone)::date
INTO fixture_date
FROM public.organizations o WHERE o.id='$ORG';
IF fixture_date IS NULL THEN
 RAISE EXCEPTION 'Reminder local date unavailable' USING ERRCODE='B1003';
END IF;
INSERT INTO public.invoices(
 id,org_id,property_id,lease_id,bill_to_contact_id,invoice_number,
 currency,issue_date,due_date,period_start,period_end,status,
 total_minor,paid_minor,source,created_by
)
SELECT invoice,l.org_id,l.property_id,l.id,c.id,
 'b010-accept-'||invoice::text,
 (SELECT code FROM public.currencies ORDER BY code LIMIT 1),
 fixture_date-10,fixture_date-5,fixture_date-10,fixture_date-1,
 'open',10000,0,'one_off',actor
FROM public.leases l
JOIN LATERAL (
 SELECT c.id FROM public.lease_parties lp
 JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
 WHERE lp.org_id=l.org_id AND lp.lease_id=l.id
 AND lp.role IN ('primary','co_tenant')
 AND c.archived_at IS NULL AND c.email IS NOT NULL
 AND btrim(c.email::text)<>''
 ORDER BY c.id LIMIT 1
) c ON true
WHERE l.org_id='$ORG' AND l.id=reminder_lease
AND l.status='active' AND l.terminated_on IS NULL;
GET DIAGNOSTICS n=ROW_COUNT;
IF n<>1 THEN
 RAISE EXCEPTION 'Reminder lease/contact fixture missing' USING ERRCODE='B1004';
END IF;
INSERT INTO public.invoice_lines(
 id,org_id,invoice_id,line_no,charge_type,description,
 quantity,unit_amount_minor,amount_minor
) VALUES(
 gen_random_uuid(),'$ORG',invoice,1,'rent',
 'b010 acceptance rollback',1,10000,10000
);

-- Mirror each rejection gate before invoking the production function.
-- Distinct SQLSTATEs identify failures without persisting messages or IDs.
IF auth.uid() IS DISTINCT FROM actor OR actor IS NULL THEN
 RAISE EXCEPTION 'Reminder actor fixture invalid' USING ERRCODE='B1005';
END IF;
IF NOT EXISTS (
 SELECT 1 FROM public.organizations o
 JOIN public.org_members m
 ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
 JOIN public.auth_sessions s ON s.id=sess AND s.user_id=actor
 JOIN public.platform_settings f ON f.key='rent_reminders_v2'
 WHERE o.id='$ORG' AND o.environment='sandbox' AND o.live_org_id='$LIVE'
 AND m.user_id=actor AND m.status='active' AND m.role IN ('admin','manager')
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
 AND f.value->'enabled'='true'::jsonb
 AND jsonb_typeof(f.value->'allowed_org_ids')='array'
 AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
) THEN
 RAISE EXCEPTION 'Reminder context fixture invalid' USING ERRCODE='B1006';
END IF;
IF NOT EXISTS (
 SELECT 1 FROM public.reminder_rules r
 WHERE r.org_id='$ORG' AND r.event_type='rent_overdue'
 AND r.is_enabled AND 'email'=ANY(r.channels)
) THEN
 RAISE EXCEPTION 'Reminder rule fixture invalid' USING ERRCODE='B1007';
END IF;
IF NOT EXISTS (
 SELECT 1 FROM public.invoices i
 JOIN public.leases l ON l.org_id=i.org_id AND l.id=i.lease_id
 JOIN public.organizations o ON o.id=l.org_id
 WHERE i.id=invoice AND i.org_id='$ORG' AND i.lease_id=reminder_lease
 AND l.status='active' AND l.terminated_on IS NULL
 AND i.status IN ('open','partially_paid') AND i.balance_minor>0
 AND i.due_date<fixture_date
 AND (clock_timestamp() AT TIME ZONE o.timezone)::date IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM public.invoice_lines il
  WHERE il.org_id=i.org_id AND il.invoice_id=i.id
  AND il.charge_type='rent' AND il.amount_minor>0)
) THEN
 RAISE EXCEPTION 'Reminder invoice fixture invalid' USING ERRCODE='B1008';
END IF;
IF EXISTS (
 SELECT 1 FROM public.email_log e
 WHERE e.org_id='$ORG' AND e.target_id=invoice
 AND e.kind IN ('rent_overdue_admin','rent_overdue_tenant')
) THEN
 RAISE EXCEPTION 'Reminder invoice already emailed' USING ERRCODE='B1009';
END IF;
IF NOT EXISTS (
 SELECT 1 FROM public.lease_parties lp
 JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
 WHERE lp.org_id='$ORG' AND lp.lease_id=reminder_lease
 AND lp.role IN ('primary','co_tenant')
 AND c.archived_at IS NULL AND c.email IS NOT NULL
 AND btrim(c.email::text)<>''
 AND EXISTS (
  SELECT 1 FROM public.organizations o WHERE o.id='$ORG'
  AND coalesce(o.settings->>'email_tenant_rent_overdue','true') <> 'false')
) THEN
 RAISE EXCEPTION 'Reminder recipient fixture invalid' USING ERRCODE='B1010';
END IF;
"

reminder="
event:=app.b010_manual_reminder('$ORG','$LIVE','sandbox',sess,
 reminder_lease,invoice,gen_random_uuid());
SELECT count(*) INTO n FROM app.b028_claim_manual('$ORG','$LIVE',
 'sandbox',sess,reminder_lease,event,'{}'::uuid[]);
IF n<1 THEN RAISE EXCEPTION 'No reminder claim'; END IF;
"

request "$(wrap "$setup $context $transition $fixture $reminder")" "$OUT/S1.json"
record S1 '.ok == true'

holder_body="
LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE;
PERFORM 1 FROM public.organizations WHERE id='$ORG' FOR UPDATE;
"

# S2 retains its original holder, readiness and acceptance criteria.
wait_holder() {
  local tag=$1 ready attempt
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

tag="b010_accept_S2_$$"
request "$(wrap "PERFORM set_config('application_name','$tag',true);
  $holder_body PERFORM pg_sleep(8);")" "$OUT/S2-holder.json" &
pid=$!; jobs+=("$pid")
if wait_holder "$tag"; then
  request "$(wrap "$setup $context $transition")" "$OUT/S2.json"
else
  failure S2 HOLDER_NOT_READY
fi
wait "$pid"
record S2 '.ok == false and .code == "55P03"
  and .sql_elapsed_ms >= 5900 and .sql_elapsed_ms < 7200'
if ! jq -e '.ok == true' "$OUT/S2-holder.json" >/dev/null; then
  statuses[${#statuses[@]}-1]=FAIL
  failed=1
fi

# Only selected monitoring fields survive sanitization. Each snapshot is a
# single read-only statement, so activity and locks share one observation.
monitor() {
  local scenario=$1 tags=$2 response snapshot started
  started=$(now_ms)
  while [[ ! -e "$OUT/$scenario-monitor.stop" ]] &&
        (( $(now_ms)-started < 30000 )); do
    response=$(bash "$RO" "
WITH a AS MATERIALIZED (
 SELECT pid,application_name,state,wait_event_type,wait_event
 FROM pg_stat_activity
 WHERE datname=current_database() AND application_name IN ($tags)
), l AS MATERIALIZED (
 SELECT a.application_name,k.relation::regclass::text AS relation,
        k.locktype,k.mode,k.granted
 FROM a JOIN pg_locks k ON k.pid=a.pid
)
SELECT json_build_object(
 'b010_monitor',true,
 'observed_at',clock_timestamp(),
 'activity',COALESCE((SELECT json_agg(json_build_object(
   'application_name',application_name,'state',state,
   'wait_event_type',wait_event_type,'wait_event',wait_event)) FROM a),'[]'::json),
 'locks',COALESCE((SELECT json_agg(row_to_json(l)) FROM l),'[]'::json)
) AS evidence;" 2>/dev/null) || response='{}'
    snapshot=$(jq -ce '
      [..|objects|select(.b010_monitor==true)] |
      select(length==1) | .[0] |
      {observed_at,activity:[.activity[] |
        {application_name,state,wait_event_type,wait_event}],
       locks:[.locks[] | {application_name,relation,locktype,mode,granted}]}
    ' <<<"$response" 2>/dev/null) || snapshot=''
    if [[ -n $snapshot ]]; then
      jq --argjson snapshot "$snapshot" '. + [$snapshot]' \
        "$OUT/$scenario-monitor.json" >"$OUT/$scenario-monitor.next"
      mv "$OUT/$scenario-monitor.next" "$OUT/$scenario-monitor.json"
    fi
    sleep 0.2
  done
}

start_monitor() {
  local scenario=$1 tags=$2
  rm -f "$OUT/$scenario-monitor.stop"
  printf '[]\n' >"$OUT/$scenario-monitor.json"
  monitor "$scenario" "$tags" &
  monitor_pid=$!
  jobs+=("$monitor_pid")
}

stop_monitor() {
  touch "$OUT/$1-monitor.stop"
  wait "$monitor_pid"
  rm -f "$OUT/$1-monitor.stop"
}

# The most recent monitor observation must establish readiness within 10s.
wait_monitor() {
  local scenario=$1 predicate=$2 deadline
  deadline=$(( $(now_ms)+10000 ))
  while (( $(now_ms)<deadline )); do
    if jq -e "last | select(. != null) | $predicate" \
      "$OUT/$scenario-monitor.json" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# regclass may include the public schema depending on monitor search_path.
s3_ready='
  any(.activity[]; .application_name=="b010-s3-holder" and .state=="active")
  and any(.locks[]; .application_name=="b010-s3-holder"
    and .granted
    and ((.relation // "") | sub("^public\\.";""))=="platform_settings"
    and .mode=="ShareRowExclusiveLock")
  and any(.locks[]; .application_name=="b010-s3-holder"
    and .granted
    and ((.relation // "") | sub("^public\\.";""))=="organizations"
    and .mode=="RowShareLock")
'

start_monitor S3 "'b010-s3-holder','b010-s3-contender'"
request "$(wrap "
PERFORM set_config('application_name','b010-s3-holder',true);
$holder_body
PERFORM pg_sleep(6);
")" "$OUT/S3-holder.json" &
pid=$!; jobs+=("$pid")
s3_started=false
if wait_monitor S3 "$s3_ready"; then
  s3_started=true
  request "$(wrap "
PERFORM set_config('application_name','b010-s3-contender',true);
$setup $context $transition
")" "$OUT/S3-result.json"
else
  failure S3-result HOLDER_NOT_READY
fi
wait "$pid"
stop_monitor S3
jq --argjson observed "$s3_started" \
  --slurpfile holder "$OUT/S3-holder.json" \
  '. + {holder_active_when_contender_started:$observed,
         holder:$holder[0]}' "$OUT/S3-result.json" >"$OUT/S3.json"
record S3 '.ok == true and .holder.ok == true
  and .holder_active_when_contender_started == true
  and .sql_elapsed_ms >= 1500'

# A holds the payment first. B starts after monitor readiness, acquires the
# opposing locks, then waits on A's transaction. A verifies that dependency
# directly before attempting context acquisition.
s4_a_ready='
 any(.activity[]; .application_name=="b010-s4-a" and .state=="active")
 and any(.locks[]; .application_name=="b010-s4-a" and .granted
   and ((.relation // "") | sub("^public\\.";""))=="payments"
   and .mode=="RowShareLock")
'
a_body="
PERFORM set_config('application_name','b010-s4-a',true);
$setup
PERFORM 1 FROM public.payments WHERE id=payment AND org_id='$ORG' FOR UPDATE;
PERFORM pg_sleep(2);
gate_deadline:=clock_timestamp()+interval '7 seconds';
LOOP
  PERFORM pg_stat_clear_snapshot();
  EXIT WHEN EXISTS (
    SELECT 1 FROM pg_stat_activity b
    WHERE b.datname=current_database()
    AND b.application_name='b010-s4-b' AND b.state='active'
    AND b.wait_event_type='Lock'
    AND EXISTS (SELECT 1 FROM pg_locks k WHERE k.pid=b.pid
      AND NOT k.granted AND k.locktype='transactionid'
      AND k.transactionid IN (
        SELECT x.transactionid FROM pg_locks x
        WHERE x.pid=pg_backend_pid() AND x.granted
        AND x.locktype='transactionid' AND x.mode='ExclusiveLock'))
    AND EXISTS (SELECT 1 FROM pg_locks k WHERE k.pid=b.pid AND k.granted
      AND k.relation='public.platform_settings'::regclass
      AND k.mode='ShareRowExclusiveLock')
    AND EXISTS (SELECT 1 FROM pg_locks k WHERE k.pid=b.pid AND k.granted
      AND k.relation='public.organizations'::regclass AND k.mode='RowShareLock')
    AND EXISTS (SELECT 1 FROM pg_locks k WHERE k.pid=b.pid AND k.granted
      AND k.relation='public.leases'::regclass AND k.mode='RowShareLock')
  );
  IF clock_timestamp()>=gate_deadline THEN
    RAISE EXCEPTION 'B overlap gate timed out' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_sleep(0.2);
END LOOP;
-- This phase marker excludes A's preliminary sleep/gate from overlap proof.
PERFORM set_config('application_name','b010-s4-a-acquire',true);
$context
$transition
"

start_monitor S4 "'b010-s4-a','b010-s4-a-acquire','b010-s4-b'"
request "$(wrap "$a_body")" "$OUT/S4-A.json" &
apid=$!; jobs+=("$apid")
s4_started=false
if wait_monitor S4 "$s4_a_ready"; then
  s4_started=true
  b_body="
  PERFORM set_config('application_name','b010-s4-b',true);
  PERFORM 1 FROM public.organizations
    WHERE id IN ('$ORG','$LIVE') ORDER BY id FOR UPDATE;
  SELECT p.id,p.lease_id INTO STRICT payment,payment_lease
    FROM public.payments p WHERE p.org_id='$ORG'
    AND p.status IN ('submitted','confirmed') ORDER BY p.id LIMIT 1;
  PERFORM 1 FROM public.leases
    WHERE id=payment_lease AND org_id='$ORG' FOR UPDATE;
  LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_sleep(1);
  PERFORM 1 FROM public.payments
    WHERE id=payment AND org_id='$ORG' FOR UPDATE;
  "
  request "$(wrap "$b_body")" "$OUT/S4-B.json" &
  bpid=$!; jobs+=("$bpid")
  wait "$bpid"
else
  failure S4-B A_NOT_READY
fi
wait "$apid"
stop_monitor S4

# Require two acquisition-phase observations at least 200ms apart.
# Normalize timestamps to UTC seconds, preserving fractional precision.
jq --argjson started "$s4_started" '
  def rel: ((.relation // "") | sub("^public\\.";""));
  def observed_seconds:
    capture("^(?<base>[0-9T:-]{19})(?<fraction>\\.[0-9]+)?(?<zone>Z|[+-][0-9]{2}:[0-9]{2})$") |
    (.base + "Z" | fromdateiso8601)
    + ((.fraction // "0") | tonumber)
    - (if .zone=="Z" then 0 else
         (.zone | capture("(?<sign>[+-])(?<hours>[0-9]{2}):(?<minutes>[0-9]{2})")) |
         (((.hours | tonumber)*3600 + (.minutes | tonumber)*60)
          * (if .sign=="-" then -1 else 1 end))
       end);
  [.[] |
    select(any(.activity[]; .application_name=="b010-s4-a-acquire"
      and .state=="active"
      and (.wait_event_type=="Lock" or .wait_event=="PgSleep"))) |
    select(any(.activity[]; .application_name=="b010-s4-b"
      and .state=="active" and .wait_event_type=="Lock")) |
    select(any(.locks[]; .application_name=="b010-s4-b"
      and .locktype=="transactionid" and .granted==false)) |
    select(any(.locks[]; .application_name=="b010-s4-a-acquire"
      and .granted and rel=="payments" and .mode=="RowShareLock")) |
    select(any(.locks[]; .application_name=="b010-s4-b"
      and .granted and rel=="organizations" and .mode=="RowShareLock")) |
    select(any(.locks[]; .application_name=="b010-s4-b"
      and .granted and rel=="leases" and .mode=="RowShareLock")) |
    select(any(.locks[]; .application_name=="b010-s4-b"
      and .granted and rel=="platform_settings"
      and .mode=="ShareRowExclusiveLock"))
  ] as $qualified |
  [$qualified[].observed_at | observed_seconds] as $times |
  (if ($times|length)>=2 then (($times|max)-($times|min))*1000
   else 0 end) as $span |
  {holder_active_when_b_started:$started,
   qualifying_snapshots:($qualified|length),
   qualifying_span_ms:$span,
   overlap_observed:($started and ($qualified|length)>=2 and $span>=200)}
' "$OUT/S4-monitor.json" >"$OUT/S4-overlap.json"

jq -s --argjson bound "$S4_TRANSACTION_BOUND_MS" \
  --slurpfile overlap "$OUT/S4-overlap.json" '{
  ok:($overlap[0].overlap_observed and all(.[];
    .code != "40P01"
    and (.ok == true or .code == "55P03")
    and (.sql_elapsed_ms | type) == "number"
    and .sql_elapsed_ms >= 0
    and .sql_elapsed_ms <= $bound)),
  elapsed_ms:([.[].elapsed_ms]|max),
  a:.[0],b:.[1],overlap:$overlap[0]
}' "$OUT/S4-A.json" "$OUT/S4-B.json" >"$OUT/S4.json"
record S4 '.ok == true and .a.code != "40P01" and .b.code != "40P01"'

if [[ -f "$OUT/S5-off-verify.json" ]]; then
  if jq -e 'type=="object"' "$OUT/S5-off-verify.json" >/dev/null 2>&1; then
    jq '{ok:(.ok==true),code:(.code // null),
         status:(if .ok==true then "VERIFIED" else "FAILED" end),
         owner:"harness"}' "$OUT/S5-off-verify.json" >"$OUT/S5.json"
  else
    failure S5 INVALID_OFF_VERIFICATION
  fi
  record S5 '.ok == true'
else
  jq -n '{status:"DEFERRED",owner:"harness",
    description:"Flags-OFF verification after rollback"}' >"$OUT/S5.json"
  names+=("S5"); statuses+=("HARNESS")
fi

printf '%-25s %s\n' SCENARIO RESULT
for i in "${!names[@]}"; do
  printf '%-25s %s\n' "${names[$i]}" "${statuses[$i]}"
done
exit "$failed"
