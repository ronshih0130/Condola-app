import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { disposableDbUrl } from "../src/server/test-disposable-db";

if (Object.entries(process.env).some(([name,value]) => Boolean(value) && (name === "DEBUG" || name === "PWDEBUG" || name.startsWith("PW_") || (name.startsWith("PLAYWRIGHT_") && !(value === "1" && ["PLAYWRIGHT_TEST","PLAYWRIGHT_NO_COPY_PROMPT"].includes(name)))))) throw new Error("Private comparison rejects debug overrides");
disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
if (process.env.DEMO_MODE !== "true") throw new Error("Private comparison requires a disposable demo database");
const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === "string"));
for (const name of Object.keys(env)) if (/SUPABASE|GOTRUE|BREVO|RESEND|LINE_CHANNEL|CLOUDFLARE|PROD|TOKEN|SECRET|_KEY/i.test(name)) delete env[name];
Object.assign(env,{SUPABASE_URL:"http://127.0.0.1:4608",SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:"e2e-photo-key",WRANGLER_SEND_METRICS:"false",NEXT_TELEMETRY_DISABLED:"1"});
for (const name of ["ID_DOC_ENCRYPTION_KEY","ID_DOC_HMAC_KEY","ID_DOC_SIGNING_SECRET","CRON_SECRET"]) env[name]=randomBytes(32).toString("hex");
process.env.PLAYWRIGHT_NO_COPY_PROMPT="1";
export default defineConfig({
  testDir:".", testMatch:"b011-handover-comparison.spec.ts", workers:1, timeout:180_000, expect:{timeout:20_000}, reporter:"line",
  use:{baseURL:"http://127.0.0.1:43148",trace:"off",video:"off",screenshot:"off"},
  webServer:[
    {cwd:resolve(__dirname,".."),command:"node e2e/b011-comparison-bucket.mjs",url:"http://127.0.0.1:4608/health",reuseExistingServer:false,timeout:30_000,stdout:"ignore",stderr:"ignore",env},
    {cwd:resolve(__dirname,".."),command:"node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43148 -H 127.0.0.1",url:"http://127.0.0.1:43148",reuseExistingServer:false,timeout:180_000,stdout:"ignore",stderr:"ignore",env},
  ], projects:[{name:"chromium",use:{...devices["Desktop Chrome"]}}],
});
