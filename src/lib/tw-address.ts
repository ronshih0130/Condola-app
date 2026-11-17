/** B-112 VEN-ADDR: client-safe Taiwanese address split / join / R2-ADDR checks (shared by the sheet and the server). */
export type AddressParts = { city: string; district: string; street: string; number: string };
export type ParsedAddress = { ok: true; parts: AddressParts } | { ok: false; parts: AddressParts };

/** The 22 counties and cities, in the 台 spelling the approved frames use. */
export const TW_CITIES = [
  "台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市", "基隆市", "新竹市", "嘉義市",
  "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣",
  "澎湖縣", "金門縣", "連江縣",
] as const;
const EMPTY: AddressParts = { city: "", district: "", street: "", number: "" };
const NUM = "[0-9０-９一二三四五六七八九十百]+";
/** A road, then optional 段 / 巷 / 弄; whitespace between those pieces is allowed (and removed from 街道). */
const STREET = new RegExp(`^(.+?(?:大道|路|街)(?:\\s*${NUM}\\s*段)?(?:\\s*${NUM}\\s*巷)?(?:\\s*${NUM}\\s*弄)?)`);
/** An ordinal road continuation (二路, 5街): a 區 or 市 right before it belongs to the road name (新竹市園區二路). */
const ROAD_AFTER = new RegExp(`^${NUM}(?:大道|路|街)`);
/** 台 and 臺 are the same character for matching the 縣市 pick-list only; every other part keeps what was typed. */
const sameTai = (value: string) => value.replace(/臺/g, "台");

/** 鄉鎮市區: the first 區, else 鄉, else 鎮, else 市 ending within five characters (so 前鎮區 and 西屯區 win over
 * 前鎮 and 西屯區市), never right before a street word or a numbered road (園區二路 is a road, not a district). */
function districtOf(rest: string) {
  for (const suffix of ["區", "鄉", "鎮", "市"]) {
    const at = rest.indexOf(suffix);
    const after = rest.slice(at + 1);
    if (at >= 1 && at <= 4 && !/[\s0-9０-９]/.test(rest.slice(0, at)) && !/^[路街道段巷弄號]/.test(after) && !ROAD_AFTER.test(after)) {
      return rest.slice(0, at + 1);
    }
  }
  return "";
}

/**
 * Splits one Taiwanese address line. A leading postal code is dropped; 縣市 is the pick-list value (台 spelling).
 * Anything it cannot place confidently is a failed parse (empty rows plus 「系統讀不出這個地址，請分開填。」), never a
 * guess: no city, nothing after the district, or no road with a 村／里／鄰 left in 門牌.
 */
export function parseTwAddress(line: string): ParsedAddress {
  let rest = line.trim().replace(/^[0-9０-９]{3,6}\s*/, "");
  const city = TW_CITIES.find(name => sameTai(rest).startsWith(name));
  if (!city) return { ok: false, parts: { ...EMPTY } };
  rest = rest.slice(city.length).trim();
  const district = districtOf(rest);
  rest = rest.slice(district.length).trim();
  const street = (STREET.exec(rest)?.[1] ?? "");
  const number = rest.slice(street.length).trim();
  if (!street && !number) return { ok: false, parts: { ...EMPTY } };
  if (!street && (/[村里鄰]/.test(number) || !/[號樓]|^[0-9０-９]/.test(number))) return { ok: false, parts: { ...EMPTY } };
  return { ok: true, parts: { city, district, street: street.replace(/\s+/g, ""), number } };
}

export type AddressError = "city" | "streetOrNumber" | "length";
/** R2-ADDR rules: 縣市 required (one of the list); 街道 and 門牌 at least one; the joined line at most 500. */
export function validateAddressParts(parts: AddressParts): AddressError[] {
  const errors: AddressError[] = [];
  if (!(TW_CITIES as readonly string[]).includes(parts.city)) errors.push("city");
  if (!parts.street.trim() && !parts.number.trim()) errors.push("streetOrNumber");
  if (joinTwAddress(parts).length > 500 || Object.values(parts).some(v => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v))) errors.push("length");
  return errors;
}

export function joinTwAddress(parts: AddressParts) {
  const street = parts.street.trim(), number = parts.number.trim();
  return `${parts.city}${parts.district.trim()}${street}${street && number ? " " : ""}${number}`;
}

