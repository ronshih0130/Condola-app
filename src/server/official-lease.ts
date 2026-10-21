import { officialLeaseTemplateText } from "../assets/leases/moi-residential-1130708";

/**
 * 內政部「住宅租賃契約書範本」, revision 113-07-08
 * (內政部台內地字第11302639334號函修正).
 *
 * Verbatim source PDF (行政院公報 / 內政部公告):
 * https://www.ey.gov.tw/File/5E3A0378DE78B213?A=C
 * Announcement, 113-07-08:
 * https://www.ey.gov.tw/Page/AABD2F12D8A6D561/58973c69-07f0-4b88-88a2-8b0b91f28241
 * Open data, 內政部地政司, dataset 178757 (packaged file dated 113-07-08):
 * https://data.gov.tw/dataset/178757
 *
 * 住宅租賃定型化契約應記載及不得記載事項, including the 114-04-18 amendment
 * (內政部台內地字第1140113583號, 應記載事項第18點, 承租人提前終止租約):
 * https://www.ey.gov.tw/Page/DFB720D019CCCB0A/478917df-7599-418f-8715-fd2716b623b4
 * Article 17 of the 113-07-08 template already uses that wording. Do not edit it.
 *
 * Stored text: src/assets/leases/moi-residential-1130708.txt
 * The Worker bundles src/assets/leases/moi-residential-1130708.ts, generated from
 * that file by scripts/embed-lease-template.mjs. Do not read the .txt at request time.
 * Paper signing only. This printout is not an electronic signature.
 * Blanks and checkboxes are filled. Missing data stays blank.
 * On the door plate, the template 號 is left out when the typed house number
 * already contains 號, and a trailing 之 is left out when there is no sub-floor.
 * Both omissions are recorded patches, so the official file can be restored.
 */

export type LeaseFieldPatch = { index: number; blank: string; value: string };

export type OfficialLeaseInput = {
  tenantName?: string | null;
  ownerName?: string | null;
  address?: unknown;
  addressDisplay?: string | null;
  floor?: string | null;
  roomLabel?: string | null;
  scope?: "whole" | "partial" | null;
  startDate?: string | null;
  endDate?: string | null;
  rentMinor?: number | null;
  rentFrequency?: string | null;
  dueDay?: number | null;
  depositMinor?: number | null;
  depositMonths?: string | null;
  electricityMethod?: string | null;
  ratePerKwh?: string | null;
  bankName?: string | null;
  /** Stored account holder. Never the 屋主 display name. */
  accountHolder?: string | null;
};

type State = { text: string; patches: LeaseFieldPatch[]; cursor: number };

export function officialLeaseTemplate() {
  return officialLeaseTemplateText;
}

const DIRECT_POWER = "「承租人自行向台灣電力股份有限公司繳納」";

function clean(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  if (/[\n\r□■]/.test(trimmed)) throw new Error("lease field has a character the form cannot hold");
  return trimmed;
}

function fillSlot(state: State, before: string, after: string, value: string) {
  const slice = state.text.slice(state.cursor);
  const beforeAt = slice.indexOf(before);
  if (beforeAt < 0) throw new Error(`lease template is missing 「${before}」`);
  const blankStart = beforeAt + before.length;
  const afterAt = slice.indexOf(after, blankStart);
  if (afterAt < 0) throw new Error(`lease template is missing 「${after}」 after 「${before}」`);
  const blank = slice.slice(blankStart, afterAt);
  if (!/^[_ \u3000]*$/.test(blank)) {
    throw new Error(`lease blank between 「${before}」 and 「${after}」 is not empty`);
  }
  const abs = state.cursor + blankStart;
  const next = clean(value);
  if (!next) {
    state.cursor = abs + blank.length;
    return;
  }
  state.text = state.text.slice(0, abs) + next + state.text.slice(abs + blank.length);
  state.patches.push({ index: abs, blank, value: next });
  state.cursor = abs + next.length;
}

function markBox(state: State, before: string, after: string, checked: boolean) {
  const token = `${before}□${after}`;
  const at = state.text.indexOf(token, state.cursor);
  if (at < 0) throw new Error(`lease template is missing checkbox 「${before}□${after}」`);
  const abs = at + before.length;
  if (checked) {
    state.text = `${state.text.slice(0, abs)}■${state.text.slice(abs + 1)}`;
    state.patches.push({ index: abs, blank: "□", value: "■" });
  }
  state.cursor = abs + 1;
}

function within(state: State, start: string, end: string, fill: (region: State) => void) {
  const startAt = state.text.indexOf(start, state.cursor);
  if (startAt < 0) throw new Error(`lease template is missing 「${start}」`);
  const regionStart = startAt + start.length;
  const endAt = state.text.indexOf(end, regionStart);
  if (endAt < 0) throw new Error(`lease template is missing 「${end}」`);
  const region: State = { text: state.text.slice(regionStart, endAt), patches: [], cursor: 0 };
  fill(region);
  state.text = state.text.slice(0, regionStart) + region.text + state.text.slice(endAt);
  for (const patch of region.patches) state.patches.push({ ...patch, index: patch.index + regionStart });
  state.cursor = regionStart + region.text.length + end.length;
}

function textOf(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(address: unknown) {
  if (typeof address === "string") {
    try {
      const parsed = JSON.parse(address) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (address && typeof address === "object") return address as Record<string, unknown>;
  return {};
}

function parseDisplay(display: string) {
  const match = display.trim().match(/^(.+?[縣市])(.+?(?:區|鄉|鎮|市))(.+)$/);
  if (!match) return { city: "", district: "", street: "" };
  return { city: match[1] ?? "", district: match[2] ?? "", street: (match[3] ?? "").trim() };
}

function readAddress(address: unknown, display: string | null | undefined) {
  const record = asRecord(address);
  let city = textOf(record.city);
  let district = textOf(record.district);
  let street = textOf(record.street);
  if (!city || !district || !street) {
    const parsed = parseDisplay(display ?? "");
    city = city || parsed.city;
    district = district || parsed.district;
    street = street || parsed.street;
  }
  return { city, district, street };
}

function cityStem(city: string) {
  return /[縣市]$/.test(city) && city.length > 1 ? city.slice(0, -1) : "";
}

function districtStem(district: string) {
  return /(?:區|鄉|鎮|市)$/.test(district) && district.length > 1 ? district.slice(0, -1) : "";
}

const ROAD_DIGIT = "0-9０-９";
const ROAD_SECTION = "0-9０-９一二三四五六七八九十";

type RoadFill = {
  name: string;
  section: string;
  lane: string;
  alley: string;
  /** Blank before the template 號. The typed house number, not the floor. */
  number: string;
  /** Blank before 樓. */
  doorFloor: string;
  /** Blank after 樓之. */
  doorSuffix: string;
};

const FLOOR_CN = "一二三四五六七八九十";
const FLOOR_TOKEN = `0-9０-９${FLOOR_CN}`;

/**
 * The house-number segment is copied as typed, so 88號之1 is never rewritten
 * as 88之1號. If that segment already contains 號, the template 號 is not
 * printed again. A floor follows in its own cell. When the house number
 * contains 號 but does not end with it, one space separates it from the
 * floor so 之1 cannot be read as part of the floor. No punctuation is
 * inserted. 樓之 keeps 之 only when there is a sub-floor. A tail the cells
 * cannot hold is printed whole in the 街(路) blank, and the floor still
 * uses its own cell.
 */
function parseRoad(street: string, unitFloor: string | null | undefined): RoadFill | null {
  const trimmed = street.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    new RegExp(
      `^(.+?)(?:路|街)(?:([${ROAD_SECTION}]+)段)?(?:([${ROAD_DIGIT}]+)巷)?(?:([${ROAD_DIGIT}]+)弄)?(.*)$`,
    ),
  );
  if (!match) return verbatimRoad(trimmed, unitFloor);
  const placed = placeDoor(match[5] ?? "", unitFloor);
  if (!placed) return verbatimRoad(trimmed, unitFloor);
  return {
    name: match[1] ?? "",
    section: match[2] ?? "",
    lane: match[3] ?? "",
    alley: match[4] ?? "",
    number: placed.number,
    doorFloor: placed.doorFloor,
    doorSuffix: placed.doorSuffix,
  };
}

function verbatimRoad(street: string, unitFloor: string | null | undefined): RoadFill | null {
  if (!/[路街]/.test(street) || !street.includes("號")) return null;
  const floor = parseUnitFloor(unitFloor);
  return {
    name: street,
    section: "",
    lane: "",
    alley: "",
    number: "",
    doorFloor: floor?.floor ?? "",
    doorSuffix: floor?.suffix ?? "",
  };
}

function placeDoor(rest: string, unitFloor: string | null | undefined) {
  const split = splitDoor(rest);
  if (!split) return null;
  const number = numberCell(split.door);
  if (number == null) return null;
  const floor = floorCells(split, unitFloor);
  return { number, doorFloor: floor.floor, doorSuffix: floor.suffix };
}

function splitDoor(rest: string): { door: string; streetFloor: string; streetSuffix: string } | null {
  if (!rest) return { door: "", streetFloor: "", streetSuffix: "" };
  if ((rest.match(/號/g) ?? []).length > 1) return null;
  // A floor is a run of digits or a run of Chinese numerals, never both.
  // 88號之1三樓 keeps 之1 on the house number; 1三 must not become the floor.
  const floorRun = `(?:[${ROAD_DIGIT}]+|[${FLOOR_CN}]+)`;
  const withFloor = rest.match(new RegExp(`^(.*?)(${floorRun})樓(?:之([${ROAD_DIGIT}]+))?$`));
  if (withFloor && rest.includes("樓")) {
    return { door: withFloor[1] ?? "", streetFloor: withFloor[2] ?? "", streetSuffix: withFloor[3] ?? "" };
  }
  const suffixOnly = rest.match(new RegExp(`^(.*?)樓之([${ROAD_DIGIT}]+)$`));
  if (suffixOnly) return { door: suffixOnly[1] ?? "", streetFloor: "", streetSuffix: suffixOnly[2] ?? "" };
  if (rest.includes("樓")) return null;
  return { door: rest, streetFloor: "", streetSuffix: "" };
}

/** Keep 號之N and 之N號 intact, including a 號 the owner already typed. */
function numberCell(door: string) {
  if (!door) return "";
  if ((door.match(/號/g) ?? []).length > 1) return null;
  return door;
}

function floorCells(split: { streetFloor: string; streetSuffix: string }, unitFloor: string | null | undefined) {
  const unit = parseUnitFloor(unitFloor);
  if (!unit) return { floor: split.streetFloor, suffix: split.streetSuffix };
  const sameFloor = !split.streetFloor || split.streetFloor === unit.floor;
  return { floor: unit.floor, suffix: unit.suffix || (sameFloor ? split.streetSuffix : "") };
}

function parseUnitFloor(floor: string | null | undefined) {
  const value = (floor ?? "").trim();
  if (!value) return null;
  const match = value.match(new RegExp(`^([${FLOOR_TOKEN}]+)(?:樓|層|[Ff])?(?:之([${ROAD_DIGIT}]+))?$`));
  if (!match) return null;
  return { floor: match[1] ?? "", suffix: match[2] ?? "" };
}

/** Whole dollars only. A fractional minor unit, or cents, stays blank. */
function yuan(minor: number | null | undefined) {
  if (minor == null || !Number.isInteger(minor) || minor < 0 || minor % 100 !== 0) return "";
  return String(minor / 100);
}

function yuanGrouped(minor: number | null | undefined) {
  return yuan(minor).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function monthsText(value: string | null | undefined) {
  if (!value) return "";
  const months = Number(value);
  if (!Number.isFinite(months) || months < 0) return "";
  return String(months);
}

function rateText(value: string | null | undefined) {
  if (!value) return "";
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return "";
  return String(rate);
}

function roc(iso: string | null | undefined) {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]) - 1911;
  if (!Number.isInteger(year) || year <= 0) return null;
  return { year: String(year), month: String(Number(match[2])), day: String(Number(match[3])) };
}

function periodMonths(frequency: string | null | undefined) {
  const value = (frequency ?? "").trim();
  if (value === "" || value === "monthly") return "1";
  if (value === "quarterly") return "3";
  if (value === "yearly") return "12";
  return "";
}

/** Drop a template label at the cursor. The patch puts it back on restore. */
function omitAtCursor(state: State, label: string) {
  if (!state.text.startsWith(label, state.cursor)) throw new Error(`lease template is missing 「${label}」`);
  state.text = state.text.slice(0, state.cursor) + state.text.slice(state.cursor + label.length);
  state.patches.push({ index: state.cursor, blank: label, value: "" });
}

/** Insert one space. fillSlot trims values, so the space is its own patch. */
function insertSpace(state: State) {
  state.text = `${state.text.slice(0, state.cursor)} ${state.text.slice(state.cursor)}`;
  state.patches.push({ index: state.cursor, blank: "", value: " " });
  state.cursor += 1;
}

/**
 * Print the house number exactly as typed. A second template 號 would turn
 * 88號之1 into 88號之1號, so that label is removed when 號 is already present.
 * 號之1 and the floor are separated with a space, not a comma. 樓之 loses 之
 * when the sub-floor cell is empty, so 3樓 is not printed as 3樓之.
 */
function fillDoorPlate(state: State, number: string, floor: string, suffix: string) {
  const containsHao = number.includes("號");
  const separate = containsHao && !number.endsWith("號") && floor !== "";
  fillSlot(state, "弄", "號", number);
  if (containsHao) omitAtCursor(state, "號");
  if (separate) insertSpace(state);
  fillSlot(state, containsHao ? "" : "號", "樓之", floor);
  if (floor && !suffix) {
    if (!state.text.startsWith("樓之", state.cursor)) throw new Error("lease template is missing 「樓之」");
    state.cursor += "樓".length;
    omitAtCursor(state, "之");
    fillSlot(state, "", "(基地坐落", "");
    return;
  }
  fillSlot(state, "樓之", "(基地坐落", suffix);
}

function fillElectricity(region: State, method: string, rate: string) {
  const submeter = method === "submeter";
  const direct = method === "tenant_direct";
  markBox(region, "由出租人負擔。\n", "由承租人負擔", submeter || direct);
  markBox(region, "由承租人負擔。\n", "以用電度數計費", submeter);
  markBox(region, "以用電度數計費：\n", "每期依電費單", submeter && !rate);
  markBox(region, "計收。\n", "每期每度", Boolean(rate));
  fillSlot(region, "每期每度", "元。但", rate);
  markBox(region, "額外收取。）\n", "非以用電度數計費", direct);
  fillSlot(region, "約定計費方式", "。", direct ? DIRECT_POWER : "");
}

/** Fill the stored 113-07-08 form. `patches` are the only differences from that file. */
export function renderOfficialLease(input: OfficialLeaseInput = {}) {
  const state: State = { text: officialLeaseTemplate(), patches: [], cursor: 0 };
  const tenant = clean(input.tenantName);
  const owner = clean(input.ownerName);
  fillSlot(state, "立契約書人承租人", "，出租人", tenant);
  fillSlot(state, "，出租人", "【為", owner);
  markBox(state, "【為", "所有權人", Boolean(owner));

  const address = readAddress(input.address, input.addressDisplay);
  const road = parseRoad(address.street, input.floor);
  fillSlot(state, "1、門牌", "縣(市)", cityStem(address.city));
  fillSlot(state, "縣(市)", "鄉（鎮、市、區）", districtStem(address.district));
  fillSlot(state, "鄉（鎮、市、區）", "街(路)", road?.name ?? "");
  fillSlot(state, "街(路)", "段", road?.section ?? "");
  fillSlot(state, "段", "巷", road?.lane ?? "");
  fillSlot(state, "巷", "弄", road?.alley ?? "");
  const looseFloor = parseUnitFloor(input.floor);
  fillDoorPlate(
    state,
    road?.number ?? "",
    road ? road.doorFloor : (looseFloor?.floor ?? ""),
    road ? road.doorSuffix : (looseFloor?.suffix ?? ""),
  );

  const partial = input.scope === "partial";
  const room = partial ? clean(input.roomLabel) : "";
  markBox(state, "租賃住宅", "全部", input.scope === "whole");
  markBox(state, "全部", "部分", partial);
  fillSlot(state, "部分：第", "層", parseUnitFloor(input.floor)?.floor ?? "");
  markBox(state, "間", "第", Boolean(room));
  fillSlot(state, "第", "室", room);

  const start = roc(input.startDate);
  const end = roc(input.endDate);
  fillSlot(state, "自民國", "年", start?.year ?? "");
  fillSlot(state, "年", "月", start?.month ?? "");
  fillSlot(state, "月", "日", start?.day ?? "");
  fillSlot(state, "至民國", "年", end?.year ?? "");
  fillSlot(state, "年", "月", end?.month ?? "");
  fillSlot(state, "月", "日", end?.day ?? "");

  const due = Number.isInteger(input.dueDay) && (input.dueDay ?? 0) >= 1 && (input.dueDay ?? 0) <= 31 ? String(input.dueDay) : "";
  fillSlot(state, "(下同)", "元整", yuanGrouped(input.rentMinor));
  fillSlot(state, "應繳納", "個月", input.rentMinor == null ? "" : periodMonths(input.rentFrequency));
  markBox(state, "並於", "每月", Boolean(due));
  fillSlot(state, "每月", "日", due);

  const bank = clean(input.bankName);
  markBox(state, "現金繳付", "轉帳繳付", Boolean(bank));
  fillSlot(state, "金融機構：", "，戶名", bank);
  fillSlot(state, "戶名：", "，帳號", clean(input.accountHolder));

  fillSlot(state, "約定為", "個月租金", monthsText(input.depositMonths));
  fillSlot(state, "金額為", "元整(最高不得超過二個月租金之總額)", yuan(input.depositMinor));

  const method = clean(input.electricityMethod);
  const rate = method === "submeter" ? rateText(input.ratePerKwh) : "";
  within(state, "(三)電費：", "(四)瓦斯費：", (region) => fillElectricity(region, method, rate));

  fillSlot(state, "出租人：\n姓名(名稱)：", "簽章", owner);
  fillSlot(state, "承租人：\n姓名(名稱)：", "簽章", tenant);

  return { text: state.text, patches: state.patches };
}
