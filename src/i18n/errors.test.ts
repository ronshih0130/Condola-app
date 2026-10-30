import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FlowError,
  logServerError,
  mapDbError,
  redactServerMessage,
  SAFE_ERROR_REASONS,
  safeDbCode,
  safeDbIdentifier,
  safeErrorReason,
} from "../server/errors";
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
  assert.deepEqual(lines[0], ["finalizeTenantId failed", {
    code: "23514",
    constraint: "id_upload_slots_ciphertext_cap",
    key: "errors.generic",
    table: "id_upload_slots",
    column: "ciphertext",
    message: "database error",
  }]);
  assert.equal(JSON.stringify(lines).includes("A123456789"), false);
  const period = mapDbError(new Error('duplicate key value violates unique constraint "utility_allocation_runs_open_period_uidx"'));
  assert.ok(period instanceof FlowError);
  assert.equal(period.key, "errors.utilityPeriod");
  const overlap = mapDbError(new Error('conflicting key value violates exclusion constraint "utility_allocation_runs_unit_period_excl"'));
  assert.ok(overlap instanceof FlowError);
  assert.equal(overlap.key, "errors.utilityOverlap");
  const logged: unknown[][] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const hidden = mapDbError(new Error('duplicate key value violates unique constraint "invoice_lines_alloc_uniq"'));
    assert.ok(hidden instanceof FlowError);
    assert.equal(hidden.key, "errors.generic");
  } finally {
    console.error = write;
  }
  assert.deepEqual(logged, [["database failed", {
    key: "errors.generic",
    message: "database error",
  }]]);
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
  assert.doesNotMatch(wizard, /t\("i_amount"\)/);
  assert.match(wizard, /i_utility_monthly/);
  assert.match(wizard, /useState\("2"\)/);
  assert.match(wizard, /useState\("5"\)/);
  assert.match(wizard, /i_room_lease_exists/);
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

test("database errors log once with safe metadata and never log arbitrary message content", () => {
  const uuid = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
  const detail = `Key (org_id, email)=(${uuid}, alice@example.com) already exists.`;
  const personal = `客戶王小明付款失敗 amount 12345 alice 091234 alice.smith 0912-345-678 A123456789 ${uuid} alice@example.com`;
  const constraint = "contacts_org_tenant_email_uniq";
  const original = { error: console.error, warn: console.warn, log: console.log };
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  console.log = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const asError of [false, true]) {
      for (const [message, key] of [
        [`duplicate key value violates unique constraint "${constraint}"`, "errors.tenantExists"],
        ["duplicate key value violates unique constraint email_uniq", "errors.emailTaken"],
      ]) {
        errors.length = 0;
        const fields = {
          message: `${message} ${personal}`,
          code: "23505",
          constraint,
          detail,
          where: "private query context",
          hint: "private hint",
          query: "private query",
          params: ["alice@example.com"],
          parameters: ["alice@example.com"],
          stack: "private driver stack",
          routine: "private routine",
          severity: "private severity",
          table: "contacts",
          column: "email",
        };
        const pg = asError ? Object.assign(new Error(fields.message), fields) : fields;
        const expectedKey = asError ? key : "errors.generic";
        const mapped = mapDbError(pg);
        assert.ok(mapped instanceof FlowError);
        assert.equal(mapped.key, expectedKey);
        assert.equal(errors.length, 1);
        assert.equal(warnings.length, 0);
        assert.equal(logs.length, 0);
        const serialized = JSON.stringify(errors);
        for (const safe of ["23505", constraint, expectedKey]) {
          assert.ok(serialized.includes(safe), safe);
        }
        for (const secret of [
          "王小明", "12345", "alice", "091234", "alice.smith",
          "alice@example.com", "0912-345-678", "A123456789", uuid,
          "Key (", detail, "private query context", "private hint",
          "private query", "params", "parameters", "stack", "routine", "severity",
        ]) {
          assert.equal(serialized.includes(secret), false, secret);
        }
        assert.deepEqual(errors[0], ["database failed", {
          code: "23505",
          constraint,
          key: expectedKey,
          table: "contacts",
          column: "email",
          message: "database error",
        }]);
        assert.deepEqual(mapped.cause, { code: "23505", constraint });
      }
    }

    for (const [message, key] of [
      ["客戶王小明付款失敗", "errors.generic"],
      ["deposit of 12345", "errors.depositCap"],
      ["alice", "errors.generic"],
      ["091234", "errors.generic"],
      ["alice.smith", "errors.generic"],
      [detail, "errors.generic"],
    ]) {
      errors.length = 0;
      const mapped = mapDbError(new Error(message));
      assert.ok(mapped instanceof FlowError);
      assert.equal(mapped.key, key);
      assert.deepEqual(errors, [["database failed", { key, message: "database error" }]]);
      assert.deepEqual(mapped.cause, {});
    }
  } finally {
    Object.assign(console, original);
  }
});

test("plain-object tenant constraint messages preserve generic error mapping", () => {
  const original = console.error;
  const lines: unknown[][] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    const mapped = mapDbError({
      message: 'duplicate key value violates unique constraint "contacts_org_tenant_email_uniq"',
    });
    assert.ok(mapped instanceof FlowError);
    assert.equal(mapped.key, "errors.generic");
    assert.deepEqual(lines, [["database failed", {
      key: "errors.generic",
      message: "database error",
    }]]);
  } finally {
    console.error = original;
  }
});

test("database metadata validators omit invalid fields instead of logging their contents", () => {
  assert.equal(safeDbCode("23505"), "23505");
  assert.equal(safeDbCode("P0001"), "P0001");
  assert.equal(safeDbIdentifier("_pricing_check"), "_pricing_check");
  assert.equal(safeDbIdentifier("a".repeat(63)), "a".repeat(63));
  const original = console.error;
  const lines: unknown[][] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    for (const value of [
      undefined, null, 23505, {}, "", "alice.smith", "091234",
      "A123456789", "alice@example.com", "王小明", "a".repeat(64),
      "23505\n", "pricing_check\n",
    ]) {
      assert.equal(safeDbCode(value), undefined);
      assert.equal(safeDbIdentifier(value), undefined);
      lines.length = 0;
      const mapped = mapDbError({
        code: value,
        constraint: value,
        table: value,
        column: value,
        message: "客戶王小明付款失敗",
      });
      assert.deepEqual(lines, [["database failed", {
        key: "errors.generic",
        message: "database error",
      }]]);
      assert.deepEqual(mapped.cause, {});
    }
    lines.length = 0;
    logServerError("database", {
      message: "deposit of 12345",
      code: "23514",
      constraint: "leases_deposit_override_pair",
      table: "leases",
      column: "deposit",
      detail: "Key (email)=(alice@example.com)",
    });
    assert.deepEqual(lines, [["database failed", {
      code: "23514",
      constraint: "leases_deposit_override_pair",
      key: "errors.generic",
      table: "leases",
      column: "deposit",
      message: "database error",
    }]]);
  } finally {
    console.error = original;
  }
});

test("the compatibility message API returns fixed safe text for every input", () => {
  for (const value of [
    "客戶王小明付款失敗",
    "deposit of 12345",
    "alice",
    "091234",
    "alice.smith",
    "alice@example.com",
    "0912-345-678",
    "+886 912 345 678",
    "A123456789",
    "A823456789",
    "AC12345678",
    "AB1234567",
    "Key (org_id, email)=(private-org, private-person) already exists.",
    'constraint "invoice_lines_alloc_uniq"',
    "'private unterminated literal",
    "safe text ".repeat(25),
    "",
  ]) {
    assert.equal(redactServerMessage(value), "database error");
  }
});

test("sanitized causes retain only exact allowlisted application reasons", () => {
  const original = console.error;
  const lines: unknown[][] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    for (const reason of SAFE_ERROR_REASONS) {
      assert.match(reason, /^[a-z]+(?:_[a-z]+)+$/);
      assert.equal(safeErrorReason(reason), reason);
      assert.deepEqual(mapDbError(new Error(reason)).cause, { reason });
      assert.deepEqual(mapDbError(Object.assign(new Error(reason), {
        code: "23514", constraint: "pricing_check", detail: "private detail",
      })).cause, { code: "23514", constraint: "pricing_check" });
    }
    for (const message of [
      "alice", "091234", "alice.smith", "private free text",
      "alice@example.com", "0912-345-678", "A123456789",
      "客戶王小明付款失敗", "deposit of 12345",
      "Key (email)=(alice@example.com)", "x".repeat(65),
      "issue", "font", "stale", "mismatch", "clipboard", "activated",
      "unknown_app_token", "vendor_pdf_unknown",
      "invalid_ticket_pricing ", " invalid_ticket_pricing",
      "invalid_ticket_pricing\n", "INVALID_TICKET_PRICING",
    ]) {
      assert.equal(safeErrorReason(message), undefined, message);
      const mapped = mapDbError(new Error(message));
      assert.deepEqual(mapped.cause, {}, message);
      assert.equal(Object.hasOwn(mapped.cause as object, "reason"), false, message);
    }
    assert.equal(safeErrorReason(undefined), undefined);
    assert.equal(safeErrorReason(91234), undefined);
    assert.equal(safeErrorReason({ reason: "invalid_ticket_pricing" }), undefined);
    assert.deepEqual(mapDbError(new Error("invalid_ticket_pricing")).cause, {
      reason: "invalid_ticket_pricing",
    });
    const flow = new FlowError("errors.required", { field: "example" });
    assert.equal(mapDbError(flow), flow);
    const serialized = JSON.stringify(lines);
    for (const secret of ["王小明", "12345", "alice", "091234", "alice.smith", "Key (", "A123456789"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  } finally {
    console.error = original;
  }
});

test("the import logging boundary uses shared allowlists and preserves its source guard", () => {
  const route = readFileSync(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const logger = route.slice(route.indexOf("function logImportFailure("));
  assert.match(logger, /console\.error\("import failed", \{/);
  assert.match(logger, /const reason = safeErrorReason\(/);
  assert.match(logger, /const code = safeDbCode\(metadata\?\.code\)/);
  assert.match(logger, /const constraint = safeDbIdentifier\(metadata\?\.constraint\)/);
  assert.doesNotMatch(logger, /\b(?:message|detail|hint|where|query|params|parameters|stack)\s*:/);
  assert.doesNotMatch(logger, /UnknownError/);

  // Execute the actual logger body without importing the route's server dependencies.
  // Only TypeScript annotations are removed; the logging implementation stays intact.
  const executable = logger
    .replace("function logImportFailure(error: unknown)", "function logImportFailure(error)")
    .replace(" as { code?: unknown; constraint?: unknown }", "")
    .replace("(value: unknown, pattern: RegExp)", "(value, pattern)");
  const logImportFailure = new Function(
    "FlowError",
    "safeDbCode",
    "safeDbIdentifier",
    "safeErrorReason",
    `${executable}\nreturn logImportFailure;`,
  )(FlowError, safeDbCode, safeDbIdentifier, safeErrorReason) as (error: unknown) => void;

  const original = console.error;
  const lines: unknown[][] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    const valid = new FlowError("errors.generic");
    valid.cause = {
      code: "23514",
      constraint: "pricing_check",
      reason: "invalid_ticket_pricing",
      message: "客戶王小明付款失敗",
      detail: "Key (email)=(alice@example.com)",
      stack: "deposit of 12345",
    };
    logImportFailure(valid);
    assert.deepEqual(lines.pop(), ["import failed", {
      name: "FlowError",
      key: "errors.generic",
      code: "23514",
      constraint: "pricing_check",
      reason: "invalid_ticket_pricing",
    }]);

    for (const reason of SAFE_ERROR_REASONS) {
      const error = new FlowError("errors.generic");
      error.cause = { reason };
      logImportFailure(error);
      assert.deepEqual(lines.pop(), ["import failed", {
        name: "FlowError",
        key: "errors.generic",
        reason,
      }]);
    }

    for (const secret of [
      "alice", "091234", "alice.smith", "王小明", "12345",
      "alice@example.com", "0912-345-678", "A123456789",
      "Key (email)=(alice@example.com)",
      "issue", "font", "stale", "mismatch", "clipboard", "activated",
      "invalid_ticket_pricing\n",
    ]) {
      lines.length = 0;
      const flow = new FlowError("errors.generic");
      flow.cause = { reason: secret };
      logImportFailure(flow);
      assert.deepEqual(lines[0], ["import failed", {
        name: "FlowError",
        key: "errors.generic",
      }]);
      assert.equal(Object.hasOwn(lines[0][1] as object, "reason"), false);

      const raw = Object.assign(new Error(secret), {
        name: secret,
        code: `${secret}!`,
        constraint: `${secret}!`,
        detail: secret,
        hint: secret,
        where: secret,
        query: secret,
        params: [secret],
        stack: secret,
      });
      logImportFailure(raw);
      logImportFailure(secret);
      assert.deepEqual(lines[1], ["import failed", { name: "Error" }]);
      assert.deepEqual(lines[2], ["import failed", { name: "Error" }]);
      assert.equal(JSON.stringify(lines).includes(secret), false, secret);
    }

    lines.length = 0;
    logImportFailure(Object.assign(new TypeError("alice"), {
      code: "23505",
      constraint: "contacts_org_tenant_email_uniq",
    }));
    assert.deepEqual(lines, [["import failed", {
      name: "TypeError",
      code: "23505",
      constraint: "contacts_org_tenant_email_uniq",
    }]]);
  } finally {
    console.error = original;
  }
});
