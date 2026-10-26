/** Sample cycle used by the property-wizard 範例試算. Not stored as a bill. */
export const EXAMPLE_KWH = [30, 50] as const;

function roundMoney(amount: number, wholeCurrency: boolean) {
  if (wholeCurrency) return Math.round(amount);
  return Math.round(amount * 100) / 100;
}

/**
 * Per-room example charges. The last room absorbs rounding so the lines
 * add up to round(total kWh × rate).
 */
export function exampleRoomCharges(rateMajor: number, samples: readonly number[], wholeCurrency: boolean) {
  if (!Number.isFinite(rateMajor) || samples.length === 0) return null;
  const totalKwh = samples.reduce((sum, kwh) => sum + kwh, 0);
  const total = roundMoney(totalKwh * rateMajor, wholeCurrency);
  const lines: number[] = [];
  let used = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (index === samples.length - 1) {
      lines.push(roundMoney(total - used, wholeCurrency));
    } else {
      const line = roundMoney(samples[index] * rateMajor, wholeCurrency);
      lines.push(line);
      used += line;
    }
  }
  return { kwh: samples, lines, total };
}

export function exampleSamplesForRooms(count: number) {
  const size = Math.max(count, 1);
  return Array.from({ length: size }, (_, index) => EXAMPLE_KWH[index % EXAMPLE_KWH.length]);
}
