// Ops-only seed generator for the platform_default LINE channel. NOT a migration and never
// run in CI. Prints a single idempotent SQL transaction to stdout for psql as the migration
// owner. Reads only public identifiers / vault refs — no secret VALUES are read or emitted.
import process from "node:process";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Single-quote a SQL literal, doubling embedded quotes; reject control characters outright. */
function sqlStr(value) {
  if (typeof value !== "string") throw new Error("SQL value must be a string");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("control character in SQL value is not allowed");
  return "'" + value.replace(/'/g, "''") + "'";
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`missing required env ${name}`);
  return value;
}

/** Pure, testable builder. env is a process.env-like record; opts = { orgs: string[], enable: boolean }. */
export function buildSeedSql(env, opts) {
  const orgs = (opts && opts.orgs) || [];
  for (const org of orgs) if (!UUID.test(org)) throw new Error(`invalid org uuid: ${org}`);
  const enable = Boolean(opts && opts.enable);

  const loginChannelId = required(env.LINE_LOGIN_CHANNEL_ID, "LINE_LOGIN_CHANNEL_ID");
  const messagingChannelId = required(env.LINE_MESSAGING_CHANNEL_ID, "LINE_MESSAGING_CHANNEL_ID");
  const oaBasicId = env.LINE_OA_BASIC_ID ? env.LINE_OA_BASIC_ID : null;
  const providerId = env.LINE_PROVIDER_ID || "condola-line-provider";
  const loginSecretRef = env.LINE_LOGIN_SECRET_REF || "line-login";
  const messagingSecretRef = env.LINE_MESSAGING_SECRET_REF || "line-messaging";
  const messagingTokenRef = env.LINE_MESSAGING_TOKEN_REF || "line-messaging-token";

  const lines = [];
  lines.push("BEGIN;");
  // Upsert the platform_default channel, keyed on the unique messaging_channel_id.
  lines.push(
    "INSERT INTO public.line_channels",
    "  (mode, org_id, display_name, line_provider_id, messaging_channel_id, messaging_channel_secret_ref,",
    "   messaging_access_token_ref, login_channel_id, login_channel_secret_ref, oa_basic_id, webhook_url, is_active)",
    `VALUES ('platform_default', NULL, ${sqlStr("租多啦Condola")}, ${sqlStr(providerId)}, ${sqlStr(messagingChannelId)}, ${sqlStr(messagingSecretRef)},`,
    `        ${sqlStr(messagingTokenRef)}, ${sqlStr(loginChannelId)}, ${sqlStr(loginSecretRef)}, ${oaBasicId === null ? "NULL" : sqlStr(oaBasicId)}, NULL, true)`,
    "ON CONFLICT (messaging_channel_id) DO UPDATE SET",
    "  mode = 'platform_default', org_id = NULL, display_name = EXCLUDED.display_name,",
    "  line_provider_id = EXCLUDED.line_provider_id, messaging_channel_secret_ref = EXCLUDED.messaging_channel_secret_ref,",
    "  messaging_access_token_ref = EXCLUDED.messaging_access_token_ref, login_channel_id = EXCLUDED.login_channel_id,",
    "  login_channel_secret_ref = EXCLUDED.login_channel_secret_ref, oa_basic_id = EXCLUDED.oa_basic_id,",
    "  webhook_url = NULL, is_active = true;",
  );
  // Verification MUST follow the upsert: the guard trigger clears tenant_config_verified_at on any content change.
  lines.push(`SELECT app.b033_channel_verify(id) FROM public.line_channels WHERE messaging_channel_id = ${sqlStr(messagingChannelId)};`);

  if (enable) {
    const orgArray = "jsonb_build_array(" + orgs.map(o => sqlStr(o)).join(", ") + ")";
    const flagMerge = '{"line_platform":true,"line_tenant_portal":true,"line_owner_portal":true,"line_vendor_portal":true,"vendor_link":true}';
    for (const org of orgs) {
      lines.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = ${sqlStr(org)}) THEN RAISE EXCEPTION 'unknown org %', ${sqlStr(org)}; END IF; END $$;`);
      lines.push(`UPDATE public.organizations SET feature_flags = coalesce(feature_flags, '{}'::jsonb) || ${sqlStr(flagMerge)}::jsonb WHERE id = ${sqlStr(org)};`);
    }
    for (const key of ["line_platform", "line_tenant_portal", "line_owner_portal", "line_vendor_portal", "vendor_link"]) {
      lines.push(
        `INSERT INTO public.platform_settings (key, value) VALUES (${sqlStr(key)}, jsonb_build_object('enabled', true, 'allowed_org_ids', ${orgArray}))`,
        "ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('enabled', true, 'allowed_org_ids',",
        "  (SELECT coalesce(jsonb_agg(DISTINCT x ORDER BY x), '[]'::jsonb) FROM jsonb_array_elements_text(" +
          "coalesce(platform_settings.value->'allowed_org_ids', '[]'::jsonb) || (EXCLUDED.value->'allowed_org_ids')) AS t(x))), updated_at = now();",
      );
    }
    for (const org of orgs) {
      lines.push(`INSERT INTO public.audit_log (org_id, actor_role, table_name, row_id, action, event_type) VALUES (${sqlStr(org)}, 'app', 'organizations', ${sqlStr(org)}, 'update', 'line_enable_internal');`);
    }
  }
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const opts = { orgs: [], enable: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--orgs") { opts.orgs = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean); }
    else if (argv[i] === "--enable") { opts.enable = true; }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(buildSeedSql(process.env, parseArgs(process.argv.slice(2))));
  } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error) + "\n");
    process.exit(1);
  }
}
