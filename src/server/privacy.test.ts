import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { maskTenantNames, privacyFromSettings } from "./privacy";

const SEED_FIRM = /FIRM_NAME|FIRM2_NAME|松信住宅管理|海岸公寓管理/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("owner privacy defaults to names on and phones off", () => {
  assert.deepEqual(privacyFromSettings(null), { showName: true, showPhone: false });
  assert.deepEqual(privacyFromSettings({}), { showName: true, showPhone: false });
  assert.deepEqual(privacyFromSettings({ show_tenant_name: false, show_tenant_phone: true }), {
    showName: false,
    showPhone: true,
  });
});

test("owner, tenant, and manager screens do not bake in demo firm names", () => {
  const root = new URL("../..", import.meta.url);
  const hits: string[] = [];
  for (const area of ["src/app/o", "src/app/t", "src/app/m"]) {
    for (const file of sources(new URL(area, root).pathname)) {
      if (SEED_FIRM.test(readFileSync(file, "utf8"))) hits.push(file);
    }
  }
  assert.deepEqual(hits, []);
  const home = readFileSync(new URL("../app/o/page.tsx", import.meta.url), "utf8");
  assert.match(home, /firm: privacy\.name/);
  const auth = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  assert.match(auth, /SELECT settings, name FROM organizations WHERE id = \$1/);
});

test("hiding names replaces tenant names and leaves the rest of the line", () => {
  const masked = maskTenantNames("租金 王小美 3F", ["王小美", "王"], "租客（已隱藏）");
  assert.equal(masked, "租金 租客（已隱藏） 3F");
});
