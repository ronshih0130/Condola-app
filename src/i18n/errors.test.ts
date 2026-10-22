import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError, logServerError, mapDbError, redactServerMessage } from "../server/errors";
import { expiredAuthCookies, expiredEnvChoiceCookies } from "../server/sign-out";
import { ERRORS, errorText } from "./errors";
import { makeT } from "./index";

const zh = JSON.parse(readFileSync(new URL("./zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
const en = JSON.parse(readFileSync(new URL("./en.json", import.meta.url), "utf8")) as Record<string, string>;

test("every error key has a translation, and an empty amount uses the amount sentence", () => {
  for (const key of Object.values(ERRORS)) {
    assert.equal(typeof zh[key], "string", key);
    assert.equal(typeof en[key], "string", key);
    assert.notEqual(zh[key], key);
    assert.notEqual(en[key], key);
  }
  assert.equal(zh.i_amount, "請輸入金額（數字，可填 0）");
  assert.equal(zh.i_field_incomplete, "{field}未完成，請確認後再送出。");
  assert.equal(zh.i_step_incomplete, "{field}未完成，請確認後再繼續。");
  assert.equal(zh.i_deposit_half_step, "押金以 0.5 個月為單位");
  assert.equal(zh.i_lease_created, "租約已建立，請將簽署連結傳給租客");
  assert.equal(en.i_lease_created, "Lease created. Please send the signing link to the tenant.");
  assert.equal(zh.i_lease_slow, "處理時間較長，請到租約列表確認");
  assert.equal(zh.i_lease_failed, "租約沒有儲存成功，請稍後再試；若持續發生請聯絡 service@condola.app");
  assert.equal(zh.i_lease_network, "租約沒有送出成功，填好的資料都還在，請再送出一次。");
  assert.equal(zh.i_lease_whole_unit, "此戶為整層出租，請選擇整層而不是房間。");
  assert.match(zh.i_charged_total, /^向租客收取 /);
  assert.equal(zh.i_rooms_hint, "請填寫每間的房號與月租（可新增或刪除房間）");
  assert.equal(zh.i_task1, "任務一：新增一個物件，依實際情況設定房間（整層或分租皆可），並加入一位屋主。");
  assert.equal(makeT("zh-TW")("i_field_incomplete", { field: zh.i_address }), "地址未完成，請確認後再送出。");
  for (const key of ["i_footer", "i_positioning", "i_pending_reports", "i_money_note"]) {
    assert.equal(zh[key].includes("房客"), false, key);
    assert.equal(zh[key].includes("租客"), true, key);
  }
  assert.equal(errorText(makeT("zh-TW"), "errors.amount"), "請輸入金額（數字，可填 0）");
  assert.equal(errorText(makeT("zh-TW"), "errors.leaseFailed"), zh.i_lease_failed);
  assert.equal(errorText(makeT("zh-TW"), "errors.leaseNetwork"), zh.i_lease_network);
  assert.equal(errorText(makeT("zh-TW"), "errors.notAKey"), "沒有完成。請檢查欄位後再試一次。");
  const mapped = mapDbError(new Error('invalid input syntax for type numeric: "NaN"'));
  assert.ok(mapped instanceof FlowError);
  assert.equal(mapped.key, "errors.amount");
  const guard = mapDbError(new Error("unit 3F is rented as whole_unit; switch it to by_room before leasing a room"));
  assert.ok(guard instanceof FlowError);
  assert.equal(guard.key, "errors.wholeUnit");
  const redacted = redactServerMessage("passport AB1234567 name '張雅文' id A123456789 arc AC12345678 detail 'duplicate key value violates'");
  assert.equal(redacted.includes("AB1234567"), false);
  assert.equal(redacted.includes("A123456789"), false);
  assert.equal(redacted.includes("AC12345678"), false);
  assert.equal(redacted.includes("張雅文"), false);
  assert.equal(redacted.includes("duplicate"), false);
  assert.match(redacted, /\[doc\]/);
  assert.match(redacted, /\[id\]/);
  assert.match(redacted, /\[arc\]/);
  assert.match(redacted, /'\[redacted\]'/);
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    logServerError("finalizeTenantId", {
      name: "error",
      code: "23514",
      routine: "ExecConstraints",
      severity: "ERROR",
      constraint: "id_upload_slots_ciphertext_cap",
      table: "id_upload_slots",
      column: "ciphertext",
      message: "new row for relation id_upload_slots violates check constraint",
      detail: "Failing row contains (A123456789)",
    });
  } finally {
    console.error = original;
  }
  const payload = lines[0]?.[1] as Record<string, unknown>;
  assert.equal(payload.constraint, "id_upload_slots_ciphertext_cap");
  assert.equal(payload.table, "id_upload_slots");
  assert.equal(payload.column, "ciphertext");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "detail"), false);
  assert.equal(JSON.stringify(lines).includes("A123456789"), false);
  const period = mapDbError(new Error('duplicate key value violates unique constraint "utility_allocation_runs_open_period_uidx"'));
  assert.ok(period instanceof FlowError);
  assert.equal(period.key, "errors.utilityPeriod");
  const overlap = mapDbError(new Error('conflicting key value violates exclusion constraint "utility_allocation_runs_unit_period_excl"'));
  assert.ok(overlap instanceof FlowError);
  assert.equal(overlap.key, "errors.utilityOverlap");
  const logged: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const hidden = mapDbError(new Error('duplicate key value violates unique constraint "invoice_lines_alloc_uniq"'));
    assert.ok(hidden instanceof FlowError);
    assert.equal(hidden.key, "errors.generic");
  } finally {
    console.error = write;
  }
  assert.match(logged.join("\n"), /invoice_lines_alloc_uniq/);
});

test("confirmation mail uses the locked button and body", () => {
  const html = readFileSync(new URL("../../supabase/templates/confirmation.html", import.meta.url), "utf8");
  const patch = readFileSync(new URL("../../supabase/templates/confirmation.patch.json", import.meta.url), "utf8");
  for (const file of [html, patch]) {
    assert.match(file, /確認電子郵件/);
    assert.match(file, /請點下方按鈕確認您的電子郵件，完成租多啦帳號註冊。/);
    assert.match(file, /\{\{ \.SiteURL \}\}\/signup\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=signup/);
    assert.equal(file.includes("確認 email"), false);
  }
});

test("sign-out expires every auth cookie variant and the wizard keeps amount errors inline", () => {
  const lines = expiredAuthCookies(["sb-example-auth-token"]);
  assert.ok(lines.some((line) => line.startsWith("condola_session=") && line.includes("Domain=.condola.app") && line.includes("Secure")));
  assert.ok(lines.some((line) => line.startsWith("sb-example-auth-token=") && line.includes("Domain=staging.condola.app")));
  assert.ok(lines.some((line) => line.startsWith("condola_org=") && line.includes("Max-Age=0")));
  const envLines = expiredEnvChoiceCookies();
  assert.ok(envLines.some((line) => line.startsWith("condola_env=") && !line.includes("Domain=")));
  assert.ok(envLines.some((line) => line.startsWith("condola_env=") && line.includes("Domain=.condola.app") && !line.includes("Secure")));
  assert.ok(envLines.every((line) => line.startsWith("condola_env=")));
  const wizard = readFileSync(new URL("../components/lease-wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, /data-testid="rent-error"/);
  assert.match(wizard, /depositMonthsOnHalfStep/);
  assert.match(wizard, /i_deposit_half_step/);
  assert.match(wizard, /i_field_incomplete/);
  assert.doesNotMatch(wizard, /data-testid="bill-total"/);
  assert.doesNotMatch(wizard, /data-testid="usage"/);
  assert.doesNotMatch(wizard, /name="billTotal"/);
  assert.match(wizard, /i_utility_monthly/);
  assert.match(wizard, /useState\("2"\)/);
  assert.match(wizard, /useState\("5"\)/);
  assert.match(wizard, /i_room_lease_exists/);
  assert.doesNotMatch(wizard, /t\("i_amount"\)/);
  assert.match(wizard, /useActionState/);
  const property = readFileSync(new URL("../components/property-wizard.tsx", import.meta.url), "utf8");
  assert.match(property, /whole-unit-name/);
  assert.match(property, /whole-unit-rent/);
  assert.match(property, /i_whole_unit_hint/);
  assert.match(property, /wholeUnit \? rooms\.slice\(0, 1\) : rooms/);
  assert.doesNotMatch(property, /deposit/);
  assert.match(property, /data-testid="add-room"/);
  assert.match(property, /type="button"/);
  assert.match(property, /submitter\.dataset\.testid !== "submit-property"/);
  assert.match(property, /blockImplicitEnter/);
  assert.match(property, /ImplicitSubmitSink/);
  assert.match(property, /useActionState/);
  assert.match(property, /i_step_incomplete/);
  assert.match(property, /data-testid="property-address-error"/);
  assert.match(property, /i_example_calc/);
  assert.match(property, /data-testid="example-calc"/);
  assert.doesNotMatch(property, /i_bill_total/);
  assert.doesNotMatch(property, /i_ph_bill/);
  assert.doesNotMatch(property, /i_ph_kwh/);
  assert.doesNotMatch(property, /ownerPhone\.trim\(\)/);
  assert.match(property, /setTimeout\(\(\) => setSubmitReady\(true\), 600\)/);
  assert.match(property, /disabled=\{blocked \|\| !submitReady\}/);
  assert.match(property, /data-saving=\{saving \? "1" : undefined\}/);
  assert.match(property, /i_portal_working/);
  assert.match(property, /i_pick_room_type/);
  assert.match(property, /data-testid="room-type-error"/);
  assert.match(property, /name="currency"/);
  assert.match(property, /filledRooms\.some\(\(room\) => !room\.type\)/);
  const propertyActions = readFileSync(new URL("../server/actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(propertyActions, /type`\) \|\| "suite"/);
  const propertyDomain = readFileSync(new URL("../server/domain.ts", import.meta.url), "utf8");
  assert.doesNotMatch(propertyDomain, /room\.roomType \|\| "suite"/);
  assert.match(propertyDomain, /assertPropertyRoomTypes\(rooms\)/);
  assert.match(propertyDomain, /SET LOCAL ROLE service_role/);
  assert.match(propertyDomain, /address->>'submitHash' = \$5/);
  assert.match(propertyDomain, /LIMIT 1/);
  assert.match(property, /key="wizard-next"/);
  assert.match(property, /key="submit-property"/);
  assert.match(property, /state\.step/);
  assert.match(property, /aria-invalid/);
  assert.match(property, /data-field/);
  assert.match(wizard, /scrollIntoView/);
  const edit = readFileSync(new URL("../app/m/properties/[id]/edit/page.tsx", import.meta.url), "utf8");
  assert.match(edit, /data-testid="meter-serial"/);
  assert.match(edit, /data-testid="property-split"/);
  assert.match(edit, /name="bill"/);
  assert.match(edit, /name="usage"/);
  assert.match(edit, /name="rate"/);
  const ownerForm = readFileSync(new URL("../components/owner-form.tsx", import.meta.url), "utf8");
  assert.match(ownerForm, /name="phone"/);
  assert.doesNotMatch(ownerForm, /name="phone"[^>]*required/);
  const domain = readFileSync(new URL("../server/domain.ts", import.meta.url), "utf8");
  assert.match(domain, /const ownerPhone = cleanPhone\(input\.ownerPhone/);
  assert.doesNotMatch(domain, /!ownerPhone\) throw new FlowError\("errors\.required"/);
  const signUp = readFileSync(new URL("../server/signup.ts", import.meta.url), "utf8");
  const start = signUp.slice(signUp.indexOf("export async function startSignup"), signUp.indexOf("export async function resendSignup"));
  assert.equal(start.includes("seedSandbox"), false);
  assert.equal(start.includes("createFirm"), false);
  assert.match(start, /supabaseSignUp/);
  assert.doesNotMatch(start, /supabaseResend/);
  const leases = readFileSync(new URL("../app/m/leases/page.tsx", import.meta.url), "utf8");
  assert.match(leases, /row\.electricity === "even"[\s\S]*i_split_even/);
  assert.match(leases, /row\.electricity === "sub_meter"[\s\S]*i_split_sub/);
  assert.doesNotMatch(leases, /i_elec_shared"\) : row\.electricity/);
  const signIn = readFileSync(new URL("../server/auth-actions.ts", import.meta.url), "utf8");
  assert.match(signIn, /clearStoredEnvChoice\(jar\)/);
  assert.match(signIn, /sessionEntryPath\(/);
  assert.doesNotMatch(signIn, /ENV_COOKIE,\s*"sandbox"/);
  const firm = readFileSync(new URL("../components/firm-steps.tsx", import.meta.url), "utf8");
  assert.match(firm, /noValidate/);
  assert.match(firm, /data-testid="firm-contact-error"/);
  assert.match(firm, /i_step_incomplete/);
  assert.doesNotMatch(firm, /\srequired(?:\s|=|{|>)/);
  assert.match(firm, /key="kind-next"/);
  assert.match(firm, /type="button"/);
  assert.match(firm, /setTimeout\(\(\) => setSubmitReady\(true\), 600\)/);
  assert.match(firm, /blockImplicitEnter/);
  assert.match(firm, /ImplicitSubmitSink/);
  assert.match(firm, /submitter\.dataset\.testid !== "firm-submit"/);
  assert.match(firm, /disabled=\{!submitReady\}/);
  const envRoute = readFileSync(new URL("../app/api/env/route.ts", import.meta.url), "utf8");
  assert.match(envRoute, /set === "live"/);
  assert.doesNotMatch(envRoute, /ENV_COOKIE_MAX_AGE/);
  assert.match(envRoute, /appCookieOptions\(\{ httpOnly: false \}\)/);
  assert.match(envRoute, /jar\.set\(ENV_COOKIE, set,/);
  const actions = readFileSync(new URL("../server/actions.ts", import.meta.url), "utf8");
  assert.match(actions, /redirect\(`\/m\/properties\/\$\{created\.propertyId\}\?created=1`\)/);
});
