const SAMPLE_MARK = "範例資料";

/** Lists show the record name. The company switcher and banner already mark the sample company. */
export function displaySampleName(name: string) {
  return name
    .replaceAll(`〔${SAMPLE_MARK}〕`, "")
    .replaceAll(`（${SAMPLE_MARK}）`, "")
    .replaceAll(" [Sample data]", "")
    .replaceAll("[Sample data]", "")
    .trim();
}
