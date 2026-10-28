import type { Client } from "pg";
import { PRIVACY_VERSION } from "./legal-versions";
import { tx, withClient } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";
import {
  partnerConsentCovered,
  partnerDocumentConfig,
  resolvePartnerDocument,
  partnerDocumentHeader,
  partnerFlag,
  partnerGateEnabled,
  selectPartnerDocuments,
  type PartnerDocument,
  type PartnerDocumentConfig,
  type PartnerDocType,
  type PartnerFlag,
  type PartnerEvidence,
  type SelectedPartnerDocument,
} from "./partner-consent-rules";

export type PartnerRuntime = {
  config: PartnerDocumentConfig;
  privacyVersion?: string;
  text(entry: PartnerDocument): string | Promise<string>;
  report(entry: { doc_type: PartnerDocType; locale: string }): void;
};

export const partnerRuntime: PartnerRuntime = {
  config: partnerDocumentConfig,
  privacyVersion: PRIVACY_VERSION,
  text: async (entry) => (await import("./partner-consent-bundle")).partnerBundledText(entry.source),
  report: (entry) => console.error(JSON.stringify({
    event: "partner_consent_config_mismatch", doc_type: entry.doc_type, locale: entry.locale,
  })),
};

export type PartnerConsentState = {
  active: boolean;
  required: boolean;
  admin: boolean;
  documents: SelectedPartnerDocument[];
};
const inactive = (): PartnerConsentState => ({
  active: false, required: false, admin: false, documents: [],
});

function reportPartnerReadFailure(stage: "flag" | "state" | "connection" | "signup"): void {
  console.error(JSON.stringify({ event: "partner_consent_read_failed", stage, fallback: "off" }));
}

export async function readPartnerFlagOn(client: Client): Promise<PartnerFlag> {
  try {
    const result = await client.query<{ value: unknown }>(
      "SELECT value FROM public.platform_settings WHERE key = 'design_partner_consent_gate'",
    );
    return partnerFlag(result.rows[0]?.value);
  } catch {
    reportPartnerReadFailure("flag");
    return "off";
  }
}

export async function verifiedPartnerDocuments(
  locale: string,
  runtime: PartnerRuntime = partnerRuntime,
): Promise<SelectedPartnerDocument[] | null> {
  let docs: SelectedPartnerDocument[];
  try {
    docs = selectPartnerDocuments(locale, runtime.config, runtime.privacyVersion);
  } catch {
    runtime.report({ doc_type: "privacy", locale: runtime.config.default_locale });
    return null;
  }
  const verified: SelectedPartnerDocument[] = [];
  for (const doc of docs) {
    try {
      verified.push(resolvePartnerDocument(doc, await runtime.text(doc), runtime.privacyVersion));
    } catch {
      // Do not log document contents, user identifiers, IPs or request headers.
      runtime.report({ doc_type: doc.doc_type, locale: doc.locale });
      return null;
    }
  }
  return verified;
}

/** OFF performs only the settings read. Document failures on an enabled
 * company retain an active gate; unrelated database read failures retain D2.
 */
export async function readPartnerStateOn(
  client: Client,
  session: Pick<Session, "kind" | "liveOrgId" | "userId" | "locale">,
  runtime: PartnerRuntime = partnerRuntime,
  knownFlag?: PartnerFlag,
): Promise<PartnerConsentState> {
  try {
    return await evaluatePartnerStateOn(client, session, runtime, knownFlag);
  } catch {
    reportPartnerReadFailure("state");
    return inactive();
  }
}

async function evaluatePartnerStateOn(
  client: Client,
  session: Pick<Session, "kind" | "liveOrgId" | "userId" | "locale">,
  runtime: PartnerRuntime,
  knownFlag?: PartnerFlag,
): Promise<PartnerConsentState> {
  if (session.kind !== "staff" || !session.liveOrgId) return inactive();
  const flag = knownFlag ?? await readPartnerFlagOn(client);
  if (flag === "off") return inactive();
  const company = await client.query<{ override: unknown; role: string | null }>(
    `SELECT o.feature_flags -> 'design_partner_consent_gate' AS override, m.role::text AS role
       FROM public.organizations o
       LEFT JOIN public.org_members m ON m.org_id = o.id AND m.user_id = $2 AND m.status = 'active'
      WHERE o.id = $1 AND o.environment = 'live'`,
    [session.liveOrgId, session.userId],
  );
  const member = company.rows[0];
  if (!member || !partnerGateEnabled(flag, member.override)) return inactive();
  // Establish the current evidence keys even when integrity is unavailable.
  // Integrity failure must not silently disable an enabled company gate.
  let candidates: SelectedPartnerDocument[] = [];
  try {
    candidates = selectPartnerDocuments(session.locale, runtime.config, runtime.privacyVersion);
    const privacy = candidates.find((doc) => doc.doc_type === "privacy");
    if (privacy) {
      try {
        const header = partnerDocumentHeader(await runtime.text(privacy), "版本");
        if (header?.trim()) privacy.version = `${header}@${runtime.privacyVersion ?? PRIVACY_VERSION}`;
      } catch {
        // Config version is the conservative fallback evidence key.
      }
    }
  } catch {
    // Invalid config cannot establish coverage.
  }
  const result = await client.query<PartnerEvidence>(
    "SELECT doc_type, version FROM public.partner_agreement_consents WHERE company_id = $1",
    [session.liveOrgId],
  );
  const covered = partnerConsentCovered(candidates, result.rows);
  const docs = await verifiedPartnerDocuments(session.locale, runtime);
  return {
    active: true, required: !covered,
    admin: member.role === "admin", documents: docs ?? [],
  };
}

export async function readPartnerState(session: Session): Promise<PartnerConsentState> {
  if (session.kind !== "staff" || !session.liveOrgId) return inactive();
  try {
    return await withClient((client) => readPartnerStateOn(client, session));
  } catch {
    reportPartnerReadFailure("connection");
    return inactive();
  }
}

/** No company exists yet: org overrides cannot apply to signup. */
export async function signupPartnerDocuments(
  locale: string,
  runtime: PartnerRuntime = partnerRuntime,
): Promise<SelectedPartnerDocument[] | null> {
  const flag = await withClient(readPartnerFlagOn);
  // null means enabled but unavailable; [] means OFF.
  return flag === "on" ? verifiedPartnerDocuments(locale, runtime) : [];
}

export type PartnerRequestMeta = { ip: string | null; ua: string | null };

export function partnerRequestMeta(headers: { get(name: string): string | null }): PartnerRequestMeta {
  return {
    ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip"),
    ua: headers.get("user-agent")?.slice(0, 512) ?? null,
  };
}

/** Caller holds the company row lock, or has just created that company in this transaction. */
export async function insertPartnerDocumentsOn(
  client: Client,
  companyId: string,
  userId: string,
  docs: readonly SelectedPartnerDocument[],
  meta: PartnerRequestMeta,
): Promise<void> {
  if (docs.length !== 2 || new Set(docs.map((doc) => doc.doc_type)).size !== 2) {
    throw new FlowError("errors.consentRequired");
  }
  // Lock membership as well as the company: a concurrent suspension/removal
  // must serialize with this authorization check and immutable snapshot.
  const member = await client.query<{ role: string; is_billing_owner: boolean }>(
    `SELECT role::text AS role, is_billing_owner
       FROM public.org_members
      WHERE org_id = $1 AND user_id = $2 AND status = 'active'
      FOR SHARE`,
    [companyId, userId],
  );
  if (member.rows[0]?.role !== "admin") throw new FlowError("errors.consentRequired");
  const profile = await client.query<{ consenter: string }>(
    `SELECT left(coalesce(nullif(btrim(display_name), ''),
                          nullif(btrim(email::text), ''), $1::text), 200) AS consenter
       FROM public.profiles WHERE id = $1 FOR SHARE`,
    [userId],
  );
  const actorRole = member.rows[0].is_billing_owner ? "owner" : "admin";
  const consenter = profile.rows[0]?.consenter || userId;
  await client.query(
    `INSERT INTO public.partner_agreement_consents
       (company_id, user_id, doc_type, version, locale, document_sha256, ip_address, user_agent,
        authority_attested, actor_role, consenter_name)
     SELECT $1::uuid, $2::uuid, d.doc_type, d.version, d.locale, d.sha256, $4::inet, $5,
            true, $6, $7
       FROM jsonb_to_recordset($3::jsonb)
         AS d(doc_type text, version text, locale text, sha256 text)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.partner_agreement_consents c
         WHERE c.company_id = $1 AND c.doc_type = d.doc_type AND c.version = d.version
      )`,
    [companyId, userId, JSON.stringify(docs), meta.ip, meta.ua?.slice(0, 512) ?? null,
      actorRole, consenter],
  );
}

/** Runs inside svc(): fresh authorization and paired evidence share its transaction. */
export async function recordPartnerConsentOn(
  client: Client,
  session: Session,
  checked: boolean,
  authority: boolean,
  meta: PartnerRequestMeta,
  runtime: PartnerRuntime = partnerRuntime,
): Promise<void> {
  if (checked !== true || authority !== true || session.kind !== "staff" || !session.liveOrgId) {
    throw new FlowError("errors.consentRequired");
  }
  const flag = await readPartnerFlagOn(client);
  if (flag === "off") throw new FlowError("errors.consentRequired");
  // Serialize double submissions, including submissions from different admins.
  await client.query("SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE", [session.liveOrgId]);
  const state = await readPartnerStateOn(client, session, runtime, flag);
  if (!state.active || !state.admin || state.documents.length !== 2) throw new FlowError("errors.consentRequired");
  await insertPartnerDocumentsOn(client, session.liveOrgId, session.userId, state.documents, meta);
}

export type PartnerHistoryRow = {
  doc_type: PartnerDocType;
  version: string;
  consented_at: Date | string;
  consenter: string;
};

export async function partnerConsentHistory(session: Session): Promise<PartnerHistoryRow[]> {
  const state = session.partnerConsent ?? await readPartnerState(session);
  if (session.kind !== "staff" || !state.active) return [];
  // Pin to live even when the viewer is using the other environment.
  return tx(session.userId, async (client) => {
    const rows = await client.query<PartnerHistoryRow>(
      `SELECT DISTINCT ON (c.doc_type) c.doc_type, c.version, c.consented_at,
              coalesce(c.consenter_name,
                       nullif(concat_ws(' · ', nullif(p.display_name, ''), p.email::text), ''),
                       c.user_id::text) AS consenter
         FROM public.partner_agreement_consents c
         LEFT JOIN public.profiles p ON p.id = c.user_id
        WHERE c.company_id = $1
        ORDER BY c.doc_type, c.consented_at DESC, c.recorded_at DESC, c.id DESC`,
      [session.liveOrgId],
    );
    return rows.rows;
  }, { orgId: session.liveOrgId, environment: "live" });
}

/** Used only by the signup transaction; flags and integrity were resolved server-side. */
export async function insertSignupPartnerConsentOn(
  client: Client,
  companyId: string,
  userId: string,
  docs: readonly SelectedPartnerDocument[],
  meta: PartnerRequestMeta,
) {
  if (!docs.length) return;
  await client.query("SET LOCAL ROLE service_role");
  await insertPartnerDocumentsOn(client, companyId, userId, docs, meta);
  await client.query("RESET ROLE");
}

