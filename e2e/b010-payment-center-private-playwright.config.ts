import { defineConfig,devices } from "@playwright/test";
import { resolve } from "node:path";
if (Object.entries(process.env).some(([name,value])=>Boolean(value) && (name==="DEBUG" || name==="PWDEBUG" || name.startsWith("PW_") || (name.startsWith("PLAYWRIGHT_") && !(value==="1" && ["PLAYWRIGHT_TEST","PLAYWRIGHT_NO_COPY_PROMPT"].includes(name)))))) throw new Error("Private payment center configuration rejects debugging overrides");
process.env.PLAYWRIGHT_NO_COPY_PROMPT="1";
process.env.B010_PRIVATE_HTTP_CONFIG="1";
const origin="http://localhost:43141";
const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==="string"));
for(const name of Object.keys(env)) if (/SUPABASE|GOTRUE|BREVO|RESEND|LINE_CHANNEL|CLOUDFLARE|PROD|TOKEN/i.test(name)) delete env[name];
export default defineConfig({
 testDir:".",testMatch:["payment-center-events.spec.ts"],fullyParallel:false,workers:1,timeout:180_000,expect:{timeout:15_000},reporter:"line",
 use:{baseURL:origin,trace:"off",video:"off",screenshot:"off"},
 webServer:{cwd:resolve(__dirname,".."),command:"node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43141 -H 127.0.0.1",url:origin,reuseExistingServer:false,timeout:180_000,stdout:"ignore",stderr:"ignore",env},
 projects:[{name:"chromium",use:{...devices["Desktop Chrome"]}}],
});
