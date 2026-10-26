import type { Metadata } from "next";
import { makeT } from "@/i18n";
import { SERVICE_EMAIL } from "@/server/mail";
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
  if (
    !asset?.assetPath || !asset.sha256 || !asset.licenseUrl ||
    !asset.gplUrl || !asset.noticeUrl || !asset.buildInputsUrl ||
    !asset.buildProvenance
  ) {
    throw new Error("Incomplete third-party asset metadata");
  }
  const provenance = asset.buildProvenance;
  const offerParts = t("i_lic_offer").split("{email}");
  if (offerParts.length !== 2) throw new Error("Invalid licence offer translation");

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
        <p>{t("i_lic_bundle_hash")}: <code style={{ overflowWrap: "anywhere" }}>{provenance.shippedBundleSha256}</code></p>
        <p>
          {t("i_lic_prebuilt")}:{" "}
          <a href={provenance.prebuiltUrl} style={{ overflowWrap: "anywhere" }}>{provenance.prebuiltUrl}</a>
        </p>
        <p>{t("i_lic_hash")}: <code style={{ overflowWrap: "anywhere" }}>{provenance.prebuiltSha256}</code></p>
        <p>{t("i_lic_wasm_hash")}: <code style={{ overflowWrap: "anywhere" }}>{provenance.embeddedWasmSha256}</code></p>
        <p>{t("i_lic_replace")}</p>
        <p>
          {offerParts[0]}
          <a href={`mailto:${SERVICE_EMAIL}`}>{SERVICE_EMAIL}</a>
          {offerParts[1]}
        </p>
        <h3>{t("i_lic_replace_steps")}</h3>
        <ol>
          <li>
            {t("i_lic_step_source")}{" "}
            <a href={asset.buildInputsUrl}>{t("i_lic_build_inputs")}</a>
            <ul>
              {[asset, ...embedded].flatMap((entry) =>
                entry.sourceArchives.map((source) => (
                  <li key={source.url}><a href={source.url}>{source.label}</a></li>
                )),
              )}
            </ul>
          </li>
          <li>{t("i_lic_step_build")}</li>
          <li>{t("i_lic_step_install")}</li>
          <li>{t("i_lic_step_interface")}</li>
          <li>
            {t("i_lic_step_place")}{" "}
            <a href={asset.assetPath}><code>{asset.assetPath}</code></a>
            <p>{t("i_lic_runtime")}</p>
          </li>
        </ol>
        <p>{t("i_lic_tested")}</p>
        <ul>
          <li><a href={asset.licenseUrl}>{t("i_lic_lgpl")}</a></li>
          <li><a href={asset.gplUrl}>{t("i_lic_gpl")}</a></li>
          <li><a href={asset.noticeUrl}>{t("i_lic_notice")}</a></li>
          <li><a href={asset.buildInputsUrl}>{t("i_lic_build_inputs")}</a></li>
          {asset.buildInputFiles.map((file) => (
            <li key={file.url}><a href={file.url}>{file.label}</a></li>
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
            {entry.copyrightHolders.length ? (
              <>
                <h4>{t("i_lic_holders")}</h4>
                <ul>
                  {entry.copyrightHolders.map((line) => (
                    <li key={line} style={{ overflowWrap: "anywhere" }}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p>
              <a href={entry.sourceUrl}>{t("i_lic_source")}</a>
              {entry.repository ? <> · <a href={entry.repository}>{t("i_lic_repository")}</a></> : null}
            </p>
            {entry.sourceArchives.length ? (
              <ul>
                {entry.sourceArchives.map((source) => (
                  <li key={source.url}>
                    <a href={source.url}>{source.label}</a>
                    <p>
                      {source.sha256 ? t("i_lic_hash") : t("i_lic_integrity")}:{" "}
                      <code style={{ overflowWrap: "anywhere" }}>{source.sha256 ?? source.integrity}</code>
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            {entry.sourceNoticesUrl ? (
              <p><a href={entry.sourceNoticesUrl}>{t("i_lic_source_notices")}</a></p>
            ) : null}
            {entry.name === "libde265" ? (
              <p>
                <a href={`/third-party/upstream/libde265-${entry.version}/AUTHORS`}>
                  {t("i_lic_authors")}
                </a>
              </p>
            ) : null}
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
