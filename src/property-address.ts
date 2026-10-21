/** Street plus door number, keeping every typed character (including 號). */
export function typedStreet(street: string, number = "") {
  return `${street.trim()}${number.trim()}`;
}

/** Taiwan display line in the order the fields were typed: 縣市、區、街道、號碼. */
export function typedAddressDisplay(city: string, district: string, street: string) {
  return `${city.trim()}${district.trim()}${street.trim()}`;
}
