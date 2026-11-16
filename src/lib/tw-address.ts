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
const STREET = new RegExp(`^(.+?(?:大道|路|街)(?:${NUM}段)?(?:${NUM}巷)?(?:${NUM}弄)?)`);

/** 鄉鎮市區: the first 區, else 鄉, else 鎮, else 市 ending within five characters (so 前鎮區 and 西屯區 win over
 * 前鎮 and 西屯區市), never right before a street word. */
function districtOf(rest: string) {
  for (const suffix of ["區", "鄉", "鎮", "市"]) {
    const at = rest.indexOf(suffix);
    if (at >= 1 && at <= 4 && !/[\s0-9０-９]/.test(rest.slice(0, at)) && !/^[路街道段巷弄號]/.test(rest.slice(at + 1))) return rest.slice(0, at + 1);
  }
  return "";
}

/**
 * Splits one Taiwanese address line. A leading postal code is dropped; 臺 is read as 台. Anything it cannot place
 * confidently is a failed parse (empty rows plus 「系統讀不出這個地址，請分開填。」), never a guess.
 */
export function parseTwAddress(line: string): ParsedAddress {
  let rest = line.trim().replace(/^[0-9０-９]{3,6}\s*/, "").replace(/^臺/, "台");
  const city = TW_CITIES.find(name => rest.startsWith(name));
  if (!city) return { ok: false, parts: { ...EMPTY } };
  rest = rest.slice(city.length).trim();
  const district = districtOf(rest);
  rest = rest.slice(district.length).trim();
  const street = STREET.exec(rest)?.[1] ?? "";
  const number = rest.slice(street.length).trim();
  if (!street && !number) return { ok: false, parts: { ...EMPTY } };
  if (number && !/[號樓]|^[0-9０-９]/.test(number) && !street) return { ok: false, parts: { ...EMPTY } };
  return { ok: true, parts: { city, district, street: street.trim(), number } };
}

export type AddressError = "city" | "streetOrNumber" | "length";
/** R2-ADDR rules: 縣市 required (one of the list); 街道 and 門牌 at least one; the joined line at most 500. */
export function validateAddressParts(parts: AddressParts): AddressError[] {
  const errors: AddressError[] = [];
  if (!(TW_CITIES as readonly string[]).includes(parts.city)) errors.push("city");
  if (!parts.street.trim() && !parts.number.trim()) errors.push("streetOrNumber");
  if (joinTwAddress(parts).length > 500 || Object.values(parts).some(v => /[\u0000-\u001f\u007f]/.test(v))) errors.push("length");
  return errors;
}

export function joinTwAddress(parts: AddressParts) {
  const street = parts.street.trim(), number = parts.number.trim();
  return `${parts.city}${parts.district.trim()}${street}${street && number ? " " : ""}${number}`;
}

