export type PhotoPhase = "before" | "during" | "after";

export type PricingMode =
  | "lump_sum"
  | "per_visit"
  | "per_ping"
  | "per_hour"
  | "per_item"
  | "material_and_labor"
  | "quote_then_approve";

export type LineItemCategory = "service" | "material" | "labor";

export interface JobTypeFieldRule {
  key: string;
  label_zh: string;
  label_en: string;
  type: "text" | "number";
  required: boolean;
}

export interface PhasePhotoRule {
  required: boolean;
  min: number;
  max: number;
}

export interface JobTypePhotoRules {
  before: PhasePhotoRule;
  during: PhasePhotoRule;
  after: PhasePhotoRule;
}

export interface AcceptanceChecklistItem {
  key: string;
  label_zh: string;
  label_en: string;
}

export interface JobTypeDefinition {
  code: string;
  name_zh: string;
  name_en: string;
  required_fields: JobTypeFieldRule[];
  photo_rules: JobTypePhotoRules;
  acceptance_checklist: AcceptanceChecklistItem[];
  pricing_modes: PricingMode[];
  sort: number;
  active: boolean;
}

export interface JobTypeLineItem {
  name: string;
  quantity: number;
  unit: string;
  /** Rounded display value; never multiply this to reconstruct the row amount. */
  unit_price_minor: number;
  amount_minor: number;
  category: LineItemCategory;
}

export const PRICING_MODE_DEFAULT_UNITS: Record<PricingMode, string> = {
  lump_sum: "式",
  per_visit: "次",
  per_ping: "坪",
  per_hour: "小時",
  per_item: "件",
  material_and_labor: "項",
  quote_then_approve: "式",
};

export const DEFAULT_JOB_TYPES: readonly JobTypeDefinition[] = [
  {
    code: "cleaning",
    name_zh: "清潔",
    name_en: "Cleaning",
    required_fields: [
      {
        key: "cleaning_scope",
        label_zh: "清潔範圍（室內／陽台／頂樓等）",
        label_en: "Cleaning Scope",
        type: "text",
        required: true,
      },
      {
        key: "area_ping_or_rooms",
        label_zh: "坪數或空間數",
        label_en: "Area (Ping) or Room Count",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 0 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "floor_clean", label_zh: "地面清潔完成", label_en: "Floor cleaned" },
      { key: "kitchen_clean", label_zh: "廚房清潔完成", label_en: "Kitchen cleaned" },
      { key: "bathroom_clean", label_zh: "衛浴清潔完成", label_en: "Bathroom cleaned" },
      { key: "trash_removed", label_zh: "垃圾與雜物清運完成", label_en: "Trash and debris removed" },
    ],
    pricing_modes: ["per_visit", "per_ping", "lump_sum"],
    sort: 10,
    active: true,
  },
  {
    code: "plumbing",
    name_zh: "水電",
    name_en: "Plumbing & Electrical",
    required_fields: [
      {
        key: "fault_location",
        label_zh: "故障位置",
        label_en: "Fault Location",
        type: "text",
        required: true,
      },
      {
        key: "pipe_or_circuit_notes",
        label_zh: "管線或迴路說明",
        label_en: "Pipe or Circuit Description",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "water_flow", label_zh: "通水正常", label_en: "Water flow normal" },
      { key: "power_supply", label_zh: "通電正常", label_en: "Power supply normal" },
      { key: "no_leak", label_zh: "無漏水", label_en: "No water leakage" },
      { key: "no_trip", label_zh: "無跳電", label_en: "No circuit tripping" },
      { key: "switches_outlets", label_zh: "開關插座測試正常", label_en: "Switches and outlets tested" },
    ],
    pricing_modes: ["per_hour", "material_and_labor", "lump_sum"],
    sort: 20,
    active: true,
  },
  {
    code: "painting",
    name_zh: "油漆",
    name_en: "Painting",
    required_fields: [
      {
        key: "area_ping",
        label_zh: "施作面積（坪數）",
        label_en: "Painted Area (Ping)",
        type: "number",
        required: true,
      },
      {
        key: "wall_or_room_location",
        label_zh: "牆面或空間位置",
        label_en: "Wall or Room Location",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "even_color", label_zh: "無明顯色差", label_en: "No visible color mismatch" },
      { key: "no_brush_marks", label_zh: "無刷痕流痕", label_en: "No brush or drip marks" },
      { key: "no_odor", label_zh: "無異味殘留", label_en: "No residual odor" },
      { key: "clean_edges", label_zh: "邊角收邊整齊", label_en: "Edges neatly finished" },
    ],
    pricing_modes: ["per_ping", "material_and_labor", "lump_sum"],
    sort: 30,
    active: true,
  },
  {
    code: "aircon",
    name_zh: "冷氣",
    name_en: "Air Conditioning",
    required_fields: [
      {
        key: "model_or_unit_count",
        label_zh: "機型或台數",
        label_en: "Model or Unit Count",
        type: "text",
        required: true,
      },
      {
        key: "service_or_repair_item",
        label_zh: "保養或維修項目",
        label_en: "Maintenance or Repair Item",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "operation_normal", label_zh: "運轉正常", label_en: "Normal operation" },
      { key: "outlet_temp_normal", label_zh: "出風溫度正常", label_en: "Normal outlet temperature" },
      { key: "filter_cleaned", label_zh: "濾網清潔完成", label_en: "Filter cleaned" },
      { key: "no_condensate_leak", label_zh: "無漏水", label_en: "No water leakage" },
    ],
    pricing_modes: ["per_item", "per_visit", "lump_sum"],
    sort: 40,
    active: true,
  },
  {
    code: "moving",
    name_zh: "搬家",
    name_en: "Moving",
    required_fields: [
      {
        key: "item_list_or_count",
        label_zh: "搬運物件清單或件數",
        label_en: "Item List or Count",
        type: "text",
        required: true,
      },
      {
        key: "origin_destination",
        label_zh: "起訖地址",
        label_en: "Origin and Destination Addresses",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 0 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "item_count_verified", label_zh: "物件件數清點一致", label_en: "Item count verified" },
      { key: "no_new_damage", label_zh: "外觀無新增損壞", label_en: "No new exterior damage" },
      { key: "placed_as_requested", label_zh: "依指定位置擺放", label_en: "Placed at designated locations" },
    ],
    pricing_modes: ["per_visit", "per_item", "lump_sum"],
    sort: 50,
    active: true,
  },
  {
    code: "pest_control",
    name_zh: "除蟲",
    name_en: "Pest Control",
    required_fields: [
      {
        key: "pest_type",
        label_zh: "蟲害類型",
        label_en: "Pest Type",
        type: "text",
        required: true,
      },
      {
        key: "treatment_area",
        label_zh: "施作範圍",
        label_en: "Treatment Area",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "treatment_applied", label_zh: "藥劑施作完成", label_en: "Treatment applied" },
      { key: "no_live_pests", label_zh: "現場無活體出現", label_en: "No live pests observed" },
      { key: "safety_notice_posted", label_zh: "安全期標示張貼", label_en: "Safety notice posted" },
    ],
    pricing_modes: ["per_visit", "lump_sum"],
    sort: 60,
    active: true,
  },
  {
    code: "locksmith",
    name_zh: "鎖匠",
    name_en: "Locksmith",
    required_fields: [
      {
        key: "lock_type",
        label_zh: "鎖具類型",
        label_en: "Lock Type",
        type: "text",
        required: true,
      },
      {
        key: "unlock_or_replace_reason",
        label_zh: "開鎖或更換原因",
        label_en: "Unlock or Replacement Reason",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 0 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "lock_operation_tested", label_zh: "鎖具開合測試正常", label_en: "Lock operation tested" },
      { key: "keys_or_codes_delivered", label_zh: "鑰匙或密碼交付數量確認", label_en: "Keys or passcodes delivered" },
    ],
    pricing_modes: ["per_item", "per_visit", "lump_sum"],
    sort: 70,
    active: true,
  },
  {
    code: "masonry",
    name_zh: "泥作",
    name_en: "Masonry",
    required_fields: [
      {
        key: "area_ping",
        label_zh: "施作面積（坪數）",
        label_en: "Work Area (Ping)",
        type: "number",
        required: true,
      },
      {
        key: "work_items",
        label_zh: "施作項目（抹平、拆除、貼磁磚等）",
        label_en: "Work Items",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: true, min: 1, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "surface_flatness", label_zh: "表面平整度確認", label_en: "Surface flatness verified" },
      { key: "no_hollow_tiles", label_zh: "敲擊無空心", label_en: "No hollow sound on tap" },
      { key: "uniform_grout", label_zh: "接縫一致", label_en: "Uniform joints" },
      { key: "curing_notice_posted", label_zh: "養護標示張貼", label_en: "Curing notice posted" },
    ],
    pricing_modes: ["per_ping", "quote_then_approve", "lump_sum"],
    sort: 80,
    active: true,
  },
  {
    code: "appliance_repair",
    name_zh: "家電維修",
    name_en: "Appliance Repair",
    required_fields: [
      {
        key: "appliance_category_model",
        label_zh: "家電品類與型號",
        label_en: "Appliance Category and Model",
        type: "text",
        required: true,
      },
      {
        key: "fault_symptom",
        label_zh: "故障現象",
        label_en: "Fault Symptom",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: false, min: 0, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "function_test_passed", label_zh: "功能測試通過", label_en: "Function test passed" },
      { key: "noise_odor_resolved", label_zh: "異音或異味排除", label_en: "Noise or odor resolved" },
      { key: "warranty_notes_recorded", label_zh: "保固或維修說明填寫完成", label_en: "Warranty or repair notes recorded" },
    ],
    pricing_modes: ["per_item", "material_and_labor", "lump_sum"],
    sort: 90,
    active: true,
  },
  {
    code: "leak_repair",
    name_zh: "抓漏",
    name_en: "Leak Detection & Repair",
    required_fields: [
      {
        key: "suspected_leak_location",
        label_zh: "疑似漏水位置",
        label_en: "Suspected Leak Location",
        type: "text",
        required: true,
      },
      {
        key: "floor_relative_position",
        label_zh: "樓層與相對位置說明",
        label_en: "Floor and Relative Position",
        type: "text",
        required: true,
      },
    ],
    photo_rules: {
      before: { required: true, min: 1, max: 5 },
      during: { required: true, min: 1, max: 5 },
      after: { required: true, min: 1, max: 5 },
    },
    acceptance_checklist: [
      { key: "water_test_no_leak", label_zh: "試水無滲漏", label_en: "Water test passed with no seepage" },
      { key: "leak_source_marked", label_zh: "漏水位置標記", label_en: "Leak source marked" },
      { key: "followup_days_noted", label_zh: "後續追蹤天數說明", label_en: "Follow-up observation days noted" },
    ],
    pricing_modes: ["quote_then_approve", "material_and_labor", "lump_sum"],
    sort: 100,
    active: true,
  },
] as const;

export function getJobTypeByCode(code: string): JobTypeDefinition | undefined {
  return DEFAULT_JOB_TYPES.find((item) => item.code === code);
}

export function validateJobTypeFields(
  requiredFields: readonly JobTypeFieldRule[],
  typeFields: Record<string, unknown> | null | undefined,
): { ok: boolean; missingKeys: string[]; invalidKeys: string[] } {
  const values = typeFields ?? {};
  const missingKeys: string[] = [];
  const invalidKeys: string[] = [];

  for (const field of requiredFields) {
    const raw = values[field.key];
    if (raw === undefined || raw === null) {
      if (field.required) missingKeys.push(field.key);
      continue;
    }
    if (field.type === "text") {
      const str = typeof raw === "string" ? raw.trim() : String(raw).trim();
      if (!str && field.required) missingKeys.push(field.key);
    } else {
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(num) || num <= 0) invalidKeys.push(field.key);
    }
  }
  return {
    ok: missingKeys.length === 0 && invalidKeys.length === 0,
    missingKeys,
    invalidKeys,
  };
}

export function validatePhasePhotoCounts(
  photoRules: JobTypePhotoRules,
  counts: Partial<Record<PhotoPhase, number>>,
): { ok: boolean; violations: PhotoPhase[] } {
  const violations: PhotoPhase[] = [];
  for (const phase of ["before", "during", "after"] as const) {
    const rule = photoRules[phase];
    const count = counts[phase] ?? 0;
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      (rule.required && count < Math.max(1, rule.min)) ||
      (!rule.required && count > 0 && count < rule.min) ||
      count > rule.max
    ) {
      violations.push(phase);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Completion requires after-photos OR a missing-photo reason.
 * Required during photos and all phase maxima remain enforced.
 */
export function validateCompletionPhotos(
  photoRules: JobTypePhotoRules,
  input: {
    before?: number;
    during?: number;
    after?: number;
    missing_photo_reason?: string | null;
  },
): { ok: boolean; violations: PhotoPhase[] } {
  const violations: PhotoPhase[] = [];
  const beforeCount = input.before ?? 0;
  const duringCount = input.during ?? 0;
  const afterCount = input.after ?? 0;
  const hasMissingReason =
    typeof input.missing_photo_reason === "string" &&
    input.missing_photo_reason.trim().length > 0;

  if (!Number.isInteger(beforeCount) || beforeCount < 0 || beforeCount > photoRules.before.max) {
    violations.push("before");
  }
  if (
    !Number.isInteger(duringCount) ||
    duringCount < 0 ||
    duringCount > photoRules.during.max ||
    (photoRules.during.required && duringCount < Math.max(1, photoRules.during.min))
  ) {
    violations.push("during");
  }
  if (!Number.isInteger(afterCount) || afterCount < 0 || afterCount > photoRules.after.max) {
    violations.push("after");
  } else if (
    photoRules.after.required &&
    afterCount < Math.max(1, photoRules.after.min) &&
    !hasMissingReason
  ) {
    violations.push("after");
  }
  return { ok: violations.length === 0, violations };
}

export function validatePricingMode(
  jobType: Pick<JobTypeDefinition, "pricing_modes">,
  mode: string,
): mode is PricingMode {
  return mode === "lump_sum" ||
    (jobType.pricing_modes as readonly string[]).includes(mode);
}

export function prefixItemNameWithJobType(
  jobTypeNameZh: string,
  itemName: string,
): string {
  const cleanJobName = jobTypeNameZh.trim();
  const cleanItemName = itemName.trim();
  if (!cleanJobName) return cleanItemName;
  const prefix = `${cleanJobName} - `;
  if (cleanItemName.startsWith(prefix) || cleanItemName === cleanJobName) {
    return cleanItemName;
  }
  return `${prefix}${cleanItemName}`;
}

export function buildJobTypeLineItem(input: {
  jobTypeNameZh: string;
  name: string;
  pricingMode: PricingMode;
  quantity?: number;
  unit?: string;
  unit_price_minor?: number;
  amount_minor?: number;
  category?: LineItemCategory;
}): { ok: true; item: JobTypeLineItem } | { ok: false; error: string } {
  const trimmedName = input.name.trim();
  if (!trimmedName) return { ok: false, error: "empty_item_name" };

  const isLumpSum = input.pricingMode === "lump_sum";
  const quantity = isLumpSum ? 1 : (input.quantity ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return { ok: false, error: "invalid_quantity" };
  }

  const unit = isLumpSum
    ? "式"
    : (input.unit?.trim() || PRICING_MODE_DEFAULT_UNITS[input.pricingMode]);

  // Retain the legacy unit-price-only input path. An explicit row amount always
  // wins; its rounded unit price is derived, never used to validate the amount.
  let amount = input.amount_minor;
  if (amount === undefined) {
    if (
      !Number.isSafeInteger(input.unit_price_minor) ||
      (input.unit_price_minor ?? 0) <= 0
    ) {
      return { ok: false, error: "invalid_unit_price_minor" };
    }
    amount = quantity * input.unit_price_minor!;
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, error: "invalid_amount_minor" };
  }
  const category = input.category ?? "service";
  if (!["service", "material", "labor"].includes(category)) {
    return { ok: false, error: "invalid_category" };
  }

  return {
    ok: true,
    item: {
      name: prefixItemNameWithJobType(input.jobTypeNameZh, trimmedName),
      quantity,
      unit,
      unit_price_minor: Math.round(amount / quantity),
      amount_minor: amount,
      category,
    },
  };
}

/**
 * Persisted ticket type_fields.pricing contains either one mode/quantity/unit
 * shared by document rows, or an ordered items array with those fields per row.
 * Only persisted data supplies these fields when pricing exists. Malformed or
 * incomplete persisted pricing must not silently fall back to caller values.
 */
export function deriveTicketDocumentItems(
  items: readonly JobTypeLineItem[],
  typeFields: Record<string, unknown> | null | undefined,
): JobTypeLineItem[] {
  const pricing = typeFields?.pricing;
  if (pricing === undefined || pricing === null) {
    return items.map((item) => ({
      ...item,
      unit_price_minor: Math.round(item.amount_minor / item.quantity),
    }));
  }
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid_ticket_pricing");
    }
    return value as Record<string, unknown>;
  };
  const saved = record(pricing);
  const rows = saved.items;
  if (rows !== undefined && (!Array.isArray(rows) || rows.length !== items.length)) {
    throw new Error("invalid_ticket_pricing");
  }

  return items.map((item, index) => {
    const row = rows === undefined ? saved : record((rows as unknown[])[index]);
    const mode = row.mode ?? saved.mode;
    if (
      typeof mode !== "string" ||
      !Object.prototype.hasOwnProperty.call(PRICING_MODE_DEFAULT_UNITS, mode)
    ) {
      throw new Error("invalid_ticket_pricing");
    }
    const lumpSum = mode === "lump_sum";
    const quantity = lumpSum ? 1 : row.quantity;
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error("invalid_ticket_pricing");
    }
    const savedUnit = row.unit;
    if (savedUnit !== undefined && (typeof savedUnit !== "string" || !savedUnit.trim())) {
      throw new Error("invalid_ticket_pricing");
    }
    const unit = lumpSum
      ? "式"
      : (typeof savedUnit === "string"
          ? savedUnit.trim()
          : PRICING_MODE_DEFAULT_UNITS[mode as PricingMode]);
    return {
      ...item,
      quantity,
      unit,
      unit_price_minor: Math.round(item.amount_minor / quantity),
    };
  });
}

export function computeMaterialLaborSplitTotals(
  items: readonly JobTypeLineItem[],
):
  | {
      ok: true;
      material_total_minor: number;
      labor_total_minor: number;
      service_total_minor: number;
      total_minor: number;
    }
  | { ok: false; error: string } {
  if (items.length === 0) return { ok: false, error: "empty_items" };

  let materialTotal = 0;
  let laborTotal = 0;
  let serviceTotal = 0;
  let total = 0;
  for (const item of items) {
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !Number.isSafeInteger(item.amount_minor) ||
      item.amount_minor <= 0 ||
      !Number.isSafeInteger(item.unit_price_minor) ||
      item.unit_price_minor < 0 ||
      item.unit_price_minor !== Math.round(item.amount_minor / item.quantity) ||
      !["service", "material", "labor"].includes(item.category)
    ) {
      return { ok: false, error: "invalid_item_numbers" };
    }
    total += item.amount_minor;
    if (!Number.isSafeInteger(total)) {
      return { ok: false, error: "invalid_item_numbers" };
    }
    if (item.category === "material") materialTotal += item.amount_minor;
    else if (item.category === "labor") laborTotal += item.amount_minor;
    else serviceTotal += item.amount_minor;
  }
  return {
    ok: true,
    material_total_minor: materialTotal,
    labor_total_minor: laborTotal,
    service_total_minor: serviceTotal,
    total_minor: total,
  };
}
