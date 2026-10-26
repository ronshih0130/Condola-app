import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeT } from "@/i18n";

const root = fileURLToPath(new URL("../..", import.meta.url));

function read(path: string) {
  return readFileSync(path, "utf8");
}

function tsxFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".open-next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(path));
    else if (entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("/m/upgrade redirects to settings and does not render the bank application", () => {
  const page = read(join(root, "src/app/m/upgrade/page.tsx"));
  assert.match(page, /redirect\("\/m\/settings"\)/);
  assert.doesNotMatch(page, /i_upgrade_submit|i_upgrade_bank|送出申請|銀行轉帳|upgrade-form|actionRequestUpgrade/);
});

test("no screen links to /m/upgrade", () => {
  const hits = tsxFiles(join(root, "src"))
    .filter((file) => read(file).includes("/m/upgrade"))
    .map((file) => relative(root, file));
  assert.deepEqual(hits, []);
  const nav = read(join(root, "src/server/perms.ts"));
  assert.equal(nav.includes("/m/upgrade"), false);
});

test("a full team shows only the plan’s user cap", () => {
  const zh = makeT("zh-TW");
  const en = makeT("en");
  assert.equal(zh("i_seat_upsell", { n: 1 }), "目前方案最多 1 位使用者");
  assert.equal(zh("i_seat_upsell", { n: 5 }), "目前方案最多 5 位使用者");
  assert.equal(en("i_seat_upsell", { n: 1 }), "Maximum users for this plan: 1.");
  assert.equal(en("i_seat_upsell", { n: 5 }), "Maximum users for this plan: 5.");
  const team = read(join(root, "src/app/m/team/page.tsx"));
  assert.match(team, /data-testid="seat-limit"/);
  assert.match(team, /t\("i_seat_upsell", \{ n: seatCap \}\)/);
  assert.doesNotMatch(team, /i_price_upgrade|申請升級|href="\/m\/upgrade"|seat-upsell/);
  const settings = read(join(root, "src/app/m/settings/page.tsx"));
  assert.match(settings, /session\.environment === "sandbox" \? null : \(/);
  assert.match(settings, /data-testid="settings-plan"/);
  assert.match(settings, /i_settings_plan/);
});
