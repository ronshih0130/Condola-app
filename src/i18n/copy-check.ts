/** Terms that must not appear in zh-TW UI copy. Stored as code points so this file is not itself product copy. */
function term(codes: readonly number[]) {
  return String.fromCharCode(...codes);
}

export const BANNED_COPY = [
  term([0x6536, 0x79df]),
  term([0x6536, 0x6b3e]),
  term([0x6b20, 0x79df]),
  term([0x5df2, 0x6536]),
  term([0x5165, 0x5e33]),
  term([0x623f, 0x6771]),
  term([0x4ee3, 0x6536]),
  term([0x8f49, 0x4ed8]),
  term([0x7d71, 0x4e00, 0x7de8, 0x865f]),
  term([0x542b, 0x7a05]),
  term([0x672c, 0x516c, 0x53f8]),
  term([0x5df2, 0x9a57, 0x8b49]),
] as const;

/**
 * Phrases that contain a banned sequence but are allowed.
 * Longer phrases are stripped before the scan. Two catalog labels share a banned pair with a ledger verb.
 */
export const COPY_ALLOWLIST = [
  term([0x5df2, 0x6536, 0x5230]),
  term([0x81ea, 0x52d5, 0x8a08, 0x5165, 0x5e33, 0x55ae]),
  term([0x4e00, 0x8d77, 0x6210, 0x70ba, 0x5b8c, 0x7f8e, 0x623f, 0x6771]),
  term([0x4e0d, 0x958b, 0x7acb, 0x7d71, 0x4e00, 0x767c, 0x7968]),
  term([0x767b, 0x5165, 0x5e33, 0x865f]),
  term([0x532f, 0x5165, 0x5e33, 0x6236]),
  term([0x52a0, 0x5165, 0x5e33, 0x55ae]),
];

export function bannedCopyHits(text: string) {
  let stripped = text;
  const allow = [...COPY_ALLOWLIST].sort((left, right) => right.length - left.length);
  for (const phrase of allow) stripped = stripped.split(phrase).join("");
  return BANNED_COPY.filter((word) => stripped.includes(word));
}
