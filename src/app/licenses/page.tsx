import type { Metadata } from "next";
import { makeT } from "@/i18n";
import { requestPrefs } from "@/server/session";
import { deliveryLabelKey, licenseEntries } from "@/server/third-party-licenses";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: makeT(prefs.locale)("i_lic_title") };
}

export default async function LicensesPage() {
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const entries = licenseEntries();
  const asset = entries.find((entry) => entry.name === "libheif-js");
  const embedded = entries.filter((entry) => entry.delivery === "inside:libheif-js");
  if (!asset?.assetPath || !asset.sha256 || !asset.licenseUrl || !asset.gplUrl || !asset.noticeUrl) {
    throw new Error("Incomplete third-party asset metadata");
  }
  return (
    <main className="legal" data-testid="licenses-page">
      <h1>{t("i_lic_title")}</h1>
      <p>{t("i_lic_intro")}</p>
      <section
        aria-labelledby="licenses-separate-title"
        style={{ border: "2px solid currentColor", padding: "1rem", marginBlock: "1rem" }}
      >
        <h2 id="licenses-separate-title">{t("i_lic_separate_title")}</h2>
        <p>{t("i_lic_upstream")} <code>libheif-bundle.mjs</code> — <code>libheif-js {asset.version}</code>.</p>
        <p>{t("i_lic_loading")}</p>
        <p>{t("i_lic_asset")}: <a href={asset.assetPath}>{asset.assetPath}</a></p>
        <p>{t("i_lic_hash")}: <code style={{ overflowWrap: "anywhere" }}>{asset.sha256}</code></p>
        <p>{t("i_lic_replace")}</p>
        <ul>
          <li><a href={asset.licenseUrl}>{t("i_lic_lgpl")}</a></li>
          <li><a href={asset.gplUrl}>{t("i_lic_gpl")}</a></li>
          <li><a href={asset.noticeUrl}>{t("i_lic_notice")}</a></li>
          <li>
            <code>libheif-js</code>: <a href={asset.sourceUrl}>{t("i_lic_source")}</a>
            {asset.repository ? <> · <a href={asset.repository}>{t("i_lic_repository")}</a></> : null}
          </li>
          {embedded.map((entry) => (
            <li key={entry.name}>
              <code>{entry.name} {entry.version}</code>: <a href={entry.sourceUrl}>{t("i_lic_source")}</a>
              {entry.repository ? <> · <a href={entry.repository}>{t("i_lic_repository")}</a></> : null}
            </li>
          ))}
        </ul>
      </section>
      <h2>{t("i_lic_packages")}</h2>
      <ul>
        {entries.map((entry) => (
          <li key={`${entry.name}@${entry.version}`}>
            <h3><code>{entry.name}</code></h3>
            <dl>
              <dt>{t("i_lic_version")}</dt><dd>{entry.version}</dd>
              <dt>{t("i_lic_license")}</dt><dd>{entry.license}</dd>
              <dt>{t("i_lic_delivery")}</dt><dd>{t(deliveryLabelKey(entry.delivery))}</dd>
            </dl>
            <p>
              <a href={entry.sourceUrl}>{t("i_lic_source")}</a>
              {entry.repository ? <> · <a href={entry.repository}>{t("i_lic_repository")}</a></> : null}
            </p>
            {entry.licenseText ? (
              <details>
                <summary>{t("i_lic_full_text")}</summary>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.licenseText}</pre>
              </details>
            ) : (
              <p>
                {entry.licenseUrl ? <a href={entry.licenseUrl}>{t("i_lic_full_text")}</a> : null}
                {entry.gplUrl ? <> · <a href={entry.gplUrl}>{t("i_lic_gpl")}</a></> : null}
                {entry.noticeUrl ? <> · <a href={entry.noticeUrl}>{t("i_lic_notice")}</a></> : null}
              </p>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
