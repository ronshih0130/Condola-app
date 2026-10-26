import { query, svc } from "./db";
import { PRIVACY_VERSION, TERMS_VERSION } from "./legal-versions";

/** Table evidence is authoritative; metadata is mirrored for rollback. */
export type ConsentSource = "signup" | "reconsent" | "invite" | "portal";

export type StoredConsent = {
  accepted_at: string;
  terms_version: string;
  privacy_version: string;
  source: ConsentSource;
};

const SOURCES: readonly ConsentSource[] = ["signup", "reconsent", "invite", "portal"];

export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export type ConsentRepository = {
  read(userId: string): Promise<StoredConsent | null>;
  write(userId: string, record: StoredConsent): Promise<void>;
};

type ConsentDeps = {
  admin: { url: string; service: string } | null;
  fetchImpl?: typeof fetch;
  sql: (userId: string, record: StoredConsent) => Promise<void>;
};

export const CONSENT_WRITE_SQL = `UPDATE auth.users
        SET raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{consent}', $2::jsonb, true),
            raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      WHERE id = $1`;

/** Server clock only. Callers must not pass a client-supplied timestamp. */
export function buildStoredConsent(source: ConsentSource, acceptedAt = new Date()): StoredConsent {
  return {
    accepted_at: acceptedAt.toISOString(),
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    source,
  };
}

export function parseAppConsent(appMetadata: unknown): StoredConsent | null {
  if (!appMetadata || typeof appMetadata !== "object" || Array.isArray(appMetadata)) return null;
  const consent = (appMetadata as Record<string, unknown>).consent;
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) return null;
  const row = consent as Record<string, unknown>;
  const source = row.source;
  const acceptedAt = row.accepted_at;
  const termsVersion = row.terms_version;
  const privacyVersion = row.privacy_version;
  if (!SOURCES.includes(source as ConsentSource)) return null;
  if (typeof acceptedAt !== "string" || acceptedAt.trim() === "" || Number.isNaN(Date.parse(acceptedAt))) return null;
  if (typeof termsVersion !== "string" || termsVersion.trim() === "") return null;
  if (typeof privacyVersion !== "string" || privacyVersion.trim() === "") return null;
  return {
    accepted_at: acceptedAt,
    terms_version: termsVersion,
    privacy_version: privacyVersion,
    source: source as ConsentSource,
  };
}

/**
 * Read the effective record. `userMetadata` is accepted so callers can pass
 * both columns through; it never satisfies the gate.
 */
export function effectiveConsent(appMetadata: unknown, userMetadata: unknown): StoredConsent | null {
  const fromApp = parseAppConsent(appMetadata);
  if (fromApp) return fromApp;
  if (userMetadata) return null;
  return null;
}

export function consentCoversCurrent(record: StoredConsent | null): boolean {
  if (!record?.accepted_at) return false;
  return record.terms_version === TERMS_VERSION && record.privacy_version === PRIVACY_VERSION;
}

/** Admin update body. `user_metadata` keeps the signup field names. */
export function consentAdminBody(record: StoredConsent) {
  return {
    app_metadata: { consent: record },
    user_metadata: {
      terms_accepted_at: record.accepted_at,
      terms_version: record.terms_version,
      privacy_version: record.privacy_version,
    },
  };
}

export function supabaseAdminAuth(): { url: string; service: string } | null {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !service) return null;
  return { url, service };
}

/** Service-role update when it is configured. A failed admin call uses the SQL merge. */
export async function deliverConsent(userId: string, record: StoredConsent, deps: ConsentDeps): Promise<"admin" | "sql"> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (deps.admin) {
    try {
      const response = await fetchImpl(`${deps.admin.url}/auth/v1/admin/users/${userId}`, {
        method: "PUT",
        headers: {
          apikey: deps.admin.service,
          Authorization: `Bearer ${deps.admin.service}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(consentAdminBody(record)),
      });
      if (response.ok) return "admin";
      console.error("consent admin update failed; using SQL merge");
    } catch {
      console.error("consent admin update failed; using SQL merge");
    }
  }
  await deps.sql(userId, record);
  return "sql";
}

export async function writeConsentSql(userId: string, record: StoredConsent, client?: Queryable) {
  const params = [userId, JSON.stringify(record), JSON.stringify(consentAdminBody(record).user_metadata)];
  if (client) {
    await client.query(CONSENT_WRITE_SQL, params);
    return;
  }
  await query(CONSENT_WRITE_SQL, params);
}

let loggedMissingConsents = false;

/** Only a missing public.consents relation permits a fail-closed fallback. */
export async function withMissingConsentFallback<T>(
  read: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const dbError = error as { code?: string; message?: string } | null;
    if (dbError?.code !== "42P01" ||
        dbError.message !== 'relation "public.consents" does not exist') throw error;
    if (!loggedMissingConsents) {
      loggedMissingConsents = true;
      console.error("public.consents unavailable; consent required");
    }
    return fallback();
  }
}

export async function loadConsentRow(userId: string, service: typeof svc = svc): Promise<StoredConsent | null> {
  return service(userId, async (client) => {
    // Recover the service transaction before returning missing evidence.
    await client.query("SAVEPOINT consent_read");
    return withMissingConsentFallback(async () => {
      const row = await client.query<StoredConsent>(
        `SELECT accepted_at::text, terms_version, privacy_version, source
           FROM public.consents WHERE user_id = $1
          ORDER BY recorded_at DESC, id DESC LIMIT 1`,
        [userId],
      );
      await client.query("RELEASE SAVEPOINT consent_read");
      return row.rows[0] ?? null;
    }, async () => {
      await client.query("ROLLBACK TO SAVEPOINT consent_read");
      await client.query("RELEASE SAVEPOINT consent_read");
      return null;
    });
  });
}

export async function persistConsent(userId: string, record: StoredConsent, service: typeof svc = svc) {
  await service(userId, async (client) => {
    await client.query(
      `INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, accepted_at, terms_version, privacy_version, source) DO NOTHING`,
      [userId, record.accepted_at, record.terms_version, record.privacy_version, record.source],
    );
  });
  await deliverConsent(userId, record, {
    admin: supabaseAdminAuth(),
    sql: (id, row) => writeConsentSql(id, row),
  });
}

export const consentRepository: ConsentRepository = {
  read: loadConsentRow,
  write: persistConsent,
};

export async function readConsent(userId: string, repo: ConsentRepository = consentRepository) {
  return repo.read(userId);
}

export async function writeConsent(
  userId: string,
  source: ConsentSource,
  acceptedAt = new Date(),
  repo: ConsentRepository = consentRepository,
) {
  const record = buildStoredConsent(source, acceptedAt);
  await repo.write(userId, record);
  return record;
}
