import { BRAND_V2_PAGE_STYLES } from "../server/brand-v2";

/** v3 is a delta; it can never attach without its v2 base. */
export function brandRoot({ v2, v3 }: { v2: boolean; v3: boolean }) {
  const attributes: { "data-brand"?: "v2"; "data-brand-v3"?: "1" } = {};
  const stylesheets: string[] = [];
  if (v2) {
    attributes["data-brand"] = "v2";
    stylesheets.push("/brand/v2/theme.css", ...BRAND_V2_PAGE_STYLES);
    if (v3) {
      attributes["data-brand-v3"] = "1";
      stylesheets.push("/brand/v3/theme.css", "/brand/v3/shell.css", "/brand/v3/today.css", "/brand/v3/money.css");
    }
  }
  return { attributes, stylesheets };
}
