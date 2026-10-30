# B005 invitation resend — closed foundation review draft

**REVIEW DRAFT / NOT APPLIED / NOT EXECUTABLE.** Source baseline `2b57eb3f5b3d292d71af49ab68b5c6641dc0c6c1`. This proposes only a closed, private schema foundation for owner/tenant resend; it does not implement a resend, authorize a sender, change a flag, send a message, or complete B005. No database or test was run. PE must inspect the actual target catalog, roles and data before deciding whether even this phase is appropriate. No final migration timestamp or deployment authority is implied.

Existing `invitations` has a global `id` PK, composite org/contact FK and composite org/lease FK, but checked-in source does not declare a unique `(org_id,id)` key. A global FK alone cannot enforce matching org. The proposal therefore explicitly adds an additive composite unique constraint before private composite FKs. It does not alter existing row values or columns, but building the constraint can lock or fail on the actual environment and must be separately planned by PE. Source shape, constraint names, PG version, owner/default ACL and staging history must be verified, not assumed from this draft. Contact and lease already have `(org_id,id)` uniqueness in source. Restrictive history FKs change future parent deletion once rows exist; retention/reset acceptance is a prerequisite to any writer, not a silent policy change.

## Proposed DDL — closed phase only

```sql
BEGIN;

-- PE: verify catalog/name/index compatibility and lock budget first.
ALTER TABLE public.invitations
  ADD CONSTRAINT b005_resend_invitation_org_id_unique UNIQUE (org_id, id);

CREATE TABLE app.b005_resend_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  live_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('live','sandbox')),
  invitation_id uuid NOT NULL,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('tenant','owner')),
  contact_id uuid NOT NULL,
  lease_id uuid,
  -- Private keyed commitments, minted only by a future trusted gateway.
  -- Neither is an unkeyed address hash or a copy of an invite token/code hash.
  source_generation_hmac bytea NOT NULL CHECK (octet_length(source_generation_hmac)=32),
  recipient_version_hmac bytea NOT NULL CHECK (octet_length(recipient_version_hmac)=32),
  commitment_key_version text NOT NULL CHECK (length(commitment_key_version) BETWEEN 1 AND 64),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  UNIQUE (org_id,actor_id,request_id),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,invitation_id)
    REFERENCES public.invitations(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id,contact_id)
    REFERENCES public.contacts(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id,lease_id)
    REFERENCES public.leases(org_id,id) ON DELETE RESTRICT,
  CHECK ((recipient_kind='tenant' AND lease_id IS NOT NULL)
      OR (recipient_kind='owner' AND lease_id IS NULL))
);

CREATE TABLE app.b005_resend_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  command_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  state text NOT NULL CHECK (state IN
    ('queued','claimed','provider_accepted','provider_rejected','failed_pre_dispatch','unknown','cancelled')),
  claim_token uuid,
  claim_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  finished_at timestamptz,
  UNIQUE (org_id,id),
  UNIQUE (org_id,command_id,attempt_no),
  FOREIGN KEY (org_id,command_id)
    REFERENCES app.b005_resend_commands(org_id,id) ON DELETE RESTRICT,
  CHECK (claim_deadline IS NULL OR (isfinite(claim_deadline) AND claim_deadline >= created_at)),
  CHECK (finished_at IS NULL OR (isfinite(finished_at) AND finished_at >= created_at)),
  CHECK ((state='claimed' AND claim_token IS NOT NULL AND claim_deadline IS NOT NULL
                           AND finished_at IS NULL)
      OR (state='queued' AND claim_token IS NULL AND claim_deadline IS NULL
                         AND finished_at IS NULL)
      OR (state IN ('provider_accepted','provider_rejected','failed_pre_dispatch','unknown','cancelled')
          AND claim_token IS NULL AND claim_deadline IS NULL AND finished_at IS NOT NULL))
);

-- Whole command identity and attempt identity are immutable even to an owner
-- using ordinary SQL; this is not a service-facing transition gateway.
CREATE FUNCTION app.b005_resend_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='b005_resend_commands' THEN
    RAISE EXCEPTION 'Immutable resend command' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.org_id,NEW.command_id,NEW.attempt_no,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.command_id,OLD.attempt_no,OLD.created_at)
  THEN RAISE EXCEPTION 'Immutable resend attempt identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b005_resend_identity_guard()
  FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b005_resend_command_immutable BEFORE UPDATE ON app.b005_resend_commands
  FOR EACH ROW EXECUTE FUNCTION app.b005_resend_identity_guard();
CREATE TRIGGER b005_resend_attempt_identity BEFORE UPDATE ON app.b005_resend_attempts
  FOR EACH ROW EXECUTE FUNCTION app.b005_resend_identity_guard();

ALTER TABLE app.b005_resend_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b005_resend_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.b005_resend_commands,app.b005_resend_attempts
  FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
```

These checks constrain row shape, not legal state transitions: owner SQL can still insert, delete or move an attempt among shaped states. Creation, deadline and finish are finite, and deadline/finish cannot precede the attempt's creation; the schema does not bound deadline duration, require a future deadline at claim, relate attempt time to command time, prove actual transition order or prevent an owner from replacing timestamps/state with another valid shape. There is intentionally **no grant, application writer, state-transition trigger, audit writer or public RPC** here. The owner remains trusted. `source_generation_hmac` and `recipient_version_hmac` are only fields in this phase: no code here proves who computed them, their domain separation, a source generation or recipient identity. The future authorized gateway must derive them from pinned actual source and current destination using a reviewed server-held key and canonical input, never from caller assertions. Key custody, versioning, rotation and bounded retention are unresolved; no key is requested or installed by this draft. A keyed commitment is sensitive operational metadata and is not anonymization. `payload_sha256` must cover a precisely defined non-secret canonical command payload; do not place recipient address, message, link or token in a low-entropy digest. If these properties cannot be provided, the closed phase cannot be promoted.

There is **no one-active-source, command or attempt constraint across distinct request IDs or source generations**. The declared uniqueness protects request identity and attempt numbering only; it cannot prevent two concurrent sends for one recipient/source. Phase 2 must define and enforce a single per-source reservation across generations, bounded claim deadlines and recovery before any writer is enabled, with actual competing-request and generation-change tests.

The composite FK guarantees that each referenced parent is in the command's org, **not** that the invitation actually has the saved kind/contact/lease, remains pending, or refers to the same token generation and recipient. Future fixed gateways must check and pin that exact relationship and check it again after waits. Existing owner/tenant rotate revokes the old invitation and creates a new UUID; team resend can mutate a generation within the same UUID, so this owner/tenant-only foundation must not be treated as a universal team identity. Existing `portal_invite_secrets` remains the sole source of raw link material, with its existing expiry/revoke/accept deletion semantics; this proposal copies no token, URL, body, raw address, provider error, or secret into private tables or a new audit record.

## Phase 2: required gateway and transaction contract — NOT IMPLEMENTED

Exact signatures, SQL bodies and grants require independent review against the actual catalog; the following names are interfaces to design, not runnable stubs:

1. `app.b005_resend_begin(org, live_org, environment, session, request_id, invitation_id, expected_payload_digest)` derives `auth.uid()` and actual session, staff role and selected org/environment through a fixed consent-first server entry; it validates strict global/allowlist/org OFF-by-default controls, contact and tenant primary-lease or owner scope, pending/unexpired source and current eligible destination. It captures a trusted, generation-bound canonical command once. The shown parameters are a design inventory, not permission for client-supplied actor, principal, role, raw address or commitment authority. Same organization/actor/request with the same exact scope and digest returns its original result; mismatch fails closed. Established accepted/bound associations are preserved and are never reset merely to resend. An expired/revoked/accepted invitation or deleted secret is not revived.
2. `app.b005_resend_status(org, live_org, environment, session, request_id)` returns only the authorized scoped command/attempt disposition, with no other-recipient counts or private material. Historical status may remain available when rollout is OFF only under an explicitly reviewed current authorization policy.
3. `app.b005_resend_claim(org, command_id, worker_context)` and `app.b005_resend_finish(org, attempt_id, claim_token, outcome)` need a trusted fixed worker boundary, strict claim token/deadline fencing, current source/recipient authorization and wall-clock recheck, atomic metadata-only audit and no ordinary direct writes. `failed_pre_dispatch` is allowed only when the trusted adapter proves no dispatch occurred; `provider_rejected` records a definitive rejection after dispatch. Timeout/connection loss or expired claim after possible dispatch becomes `unknown`, never silently requeued. `provider_accepted` means provider accepted the request, **not delivered**. A retry after `unknown` needs an explicit reviewed recovery policy; neither a new worker token nor the mere passage of time authorizes duplicate sending.
4. A local/mock adapter may use a short-lived actual link from the existing secret store just in time, only after revalidating current source and recipient. External I/O is outside locks; a DB transaction cannot atomically guarantee exactly-once network delivery. A fixed capture/mock must not be reachable as a real provider, and must not log/store the address, link or message. Unknown commit/result must retain the same request identity. Review recipient change, acceptance/revocation and expiry between claim and use; do not claim that stale authorization can be pinned across network I/O.

For every write: preauthorize before privileged locks, pin platform controls, selected/live org and actor/session/membership; then exact contact/lease/party, invitation and secret in a proven order, followed by command/attempt and audit. Existing portal issuer is contact-advisory → contact → invitation; acceptance has a different actual order. Inventory all implicit FK KEY SHARE locks, existing secret-deletion triggers, uniqueness/index waits, audit parents and old workers; use reviewed nonblocking admission or a reconciled canonical order and recheck source/mappings after waits. A fixed one-operation server-owned transaction must complete business writes, flush constraints, revalidate current authorization as its last business read, then immediately await COMMIT; do not imply wall-clock authorization at an arbitrary later durable ACK or arbitrary service SQL. No global deadlock-free assertion follows.

## Audit privacy and lifecycle blockers

Baseline `20261018120000_schema.sql:1588–1614` installs generic `fn_audit` on `invitations`; it serializes complete OLD/NEW rows, including existing email and `code_hash`. Source search found no later replacement/drop in the reviewed tree. Therefore a new safe audit row alone does **not** make invitation issuance/rotation privacy-safe. Before any such mutation, PE and reviewer must reconcile the actual installed trigger and a narrowly reviewed fix-forward redaction/compatibility design, without changing old audit data or legal copy. Do not attach generic `fn_audit` to either new private table. New audit records may contain only approved metadata/opaque IDs and result class; no address, token, URL, message body, credential fingerprint, unkeyed address hash or raw error.

Restrictive FKs can block existing deletion of organizations, contacts, leases and invitations after first command. The current guarded demo reset in `src/server/seed.ts` explicitly cleans private tables under its existing trusted replica-owner reset, then public parents; it does not know these proposed tables. PE must approve production retention/deletion semantics and a coordinated **specific child-first** demo cleanup (attempts → commands → invitation/contact/lease/org parents), older-schema-absence behavior and admission against concurrent writes. No new production purge, generic app-schema truncate, CASCADE, service grant or caller-GUC bypass is proposed. Until solved, do not enable a writer or create persistent real rows.

## PE / QA verification before any adoption

- Independently compare target catalog, extension/PG version, object names, effective owner/default ACL/RLS and composite keys; review additive constraint lock cost, historical callers and an actual approved rollback target. Preserve OFF behavior and existing completed links, including older application/worker combinations.
- Fresh install and upgrade, schema forgery/cross-org FK negatives, app/PUBLIC/service privilege denials, immutable identity and exact state constraints; actual command digest/generation/recipient derivation with wrong source/role/session/consent/organization, missing/invalid flags, expiry and post-wait revocation.
- Both lock orders for issue/rotate/accept/claim/finish and reset; duplicate concurrent command/claim, stale token, expired claim, provider timeout/unknown, mock known-pre-dispatch failure, replay and payload mismatch, atomic audit failure rollback and no exposed sensitive data. Prove no old writer can bypass an adopted protected source; unsupported old writer paths stay explicitly unsupported.
- Repeat guarded local demo reset with real synthetic parent/child rows and orphan counts, absent-schema compatibility and unrelated private-table preservation, once the reset design is separately authorized. All local mocks use disposable fixtures only. Staging/real transport, QA/Class B and Ron activation remain separate. No production database access or provider traffic is authorized here.
