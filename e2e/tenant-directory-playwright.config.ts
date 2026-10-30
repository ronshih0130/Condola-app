import { defineConfig,devices } from "@playwright/test";
export default defineConfig({
 testDir:".",testMatch:"b015-directory-local.spec.ts",workers:1,timeout:180000,expect:{timeout:20000},
 use:{baseURL:"http://127.0.0.1:43123",trace:"retain-on-failure"},
 webServer:[
  {cwd:"..",command:"node e2e/photo-bucket.mjs",url:"http://127.0.0.1:4599/health",reuseExistingServer:false,timeout:30000},
  {cwd:"..",command:"npm run dev:e2e",url:"http://127.0.0.1:43123",reuseExistingServer:false,timeout:180000,env:{...process.env,SUPABASE_URL:"http://127.0.0.1:4599",SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:"e2e-photo-key"}},
 ],projects:[{name:"chromium",use:{...devices["Desktop Chrome"]}}],
});
