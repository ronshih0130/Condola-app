import { isUuid } from "@/server/repair-rules";

type SmsFlag = "sms_otp" | "signup_verification" | "tenant_invite";

async function flagsOn(orgId: string, keys: readonly SmsFlag[]): Promise<boolean> {
  if (!isUuid(orgId)) return false;
  try {
    const { svc } = await import("@/server/db");
    return await svc(null, async (client) => {
      const { rows } = await client.query<{ key: string; enabled: unknown }>(
        `SELECT required.key, EXISTS (
           SELECT 1 FROM public.organizations o
           JOIN public.platform_settings f ON f.key = required.key
           WHERE o.id = $1
             AND o.feature_flags->(required.key) = 'true'::jsonb
             AND f.value->'enabled' = 'true'::jsonb
             AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
             AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
         ) AS enabled
         FROM unnest($2::text[]) AS required(key)`,
        [orgId, keys],
      );
      return keys.every(key => rows.some(row => row.key === key && row.enabled === true));
    });
  } catch {
    return false;
  }
}

export function smsOtpFlagOn(orgId: string): Promise<boolean> {
  return flagsOn(orgId, ["sms_otp"]);
}

export function signupVerificationFlagOn(orgId: string): Promise<boolean> {
  return flagsOn(orgId, ["signup_verification"]);
}

export function tenantInviteFlagOn(orgId: string): Promise<boolean> {
  return flagsOn(orgId, ["tenant_invite"]);
}

export function signupRouteFlagsOn(orgId: string): Promise<boolean> {
  return flagsOn(orgId, ["sms_otp", "signup_verification"]);
}
