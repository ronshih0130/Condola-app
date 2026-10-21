"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useT } from "./locale";
import { csvDocument, buildXlsx, readSpreadsheet, SpreadsheetError } from "@/lib/spreadsheet";
import {
  IMPORT_COMMIT_BATCH,
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  fieldLabel,
  matchColumns,
  missingRequired,
  rowHasError,
  tableToRows,
  templateHeaders,
  validateImportRows,
  type ColumnMapping,
  type ImportField,
  type ImportIssue,
  type ImportRequestRow,
  type ImportResult,
  type ParsedImportRow,
} from "@/server/owner-import";
import { Stepper } from "./ui";

const PAGE = 20;

const EMPTY: ImportResult = {
  dryRun: true,
  fileName: "",
  created: { properties: 0, units: 0, rooms: 0, owners: 0, tenants: 0, leases: 0, vacant: 0 },
  reused: { units: 0, tenants: 0, leases: 0 },
  openingMinor: 0,
  errors: [],
  warnings: [],
};

export function ImportWizard() {
  const t = useT();
  const steps = [t("im_s1"), t("im_s2"), t("im_s3"), t("im_s4"), t("im_s5")];
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState("");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [encodingChoice, setEncodingChoice] = useState<"auto" | "utf-8" | "big5">("auto");
  const [detected, setDetected] = useState("");
  const [table, setTable] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [dry, setDry] = useState<ImportResult>(EMPTY);
  const [done, setDone] = useState<ImportResult>(EMPTY);
  const [previewErrors, setPreviewErrors] = useState<ImportIssue[]>([]);

  const headers = table[0] ?? [];
  const parsed = useMemo(() => (mapping ? validateImportRows(tableToRows(table, mapping)) : []), [mapping, table]);
  const skipSet = useMemo(() => new Set(skipped), [skipped]);
  const unskippedErrors = parsed.filter((row) => rowHasError(row) && !skipSet.has(row.line));
  const sending = parsed.filter((row) => !rowHasError(row));
  const problems = parsed.filter((row) => row.issues.some((issue) => (onlyErrors ? issue.severity === "error" : true)));
  const pageCount = Math.max(1, Math.ceil(problems.length / PAGE));
  const visible = problems.slice(page * PAGE, page * PAGE + PAGE);
  const missing = mapping ? missingRequired(mapping) : [];

  async function loadFile(file: File, choice: "auto" | "utf-8" | "big5") {
    setNotice("");
    const buffer = new Uint8Array(await file.arrayBuffer());
    setBytes(buffer);
    setFileName(file.name);
    try {
      const read = await readSpreadsheet(file.name, buffer, file.name.toLowerCase().endsWith(".xlsx") ? "auto" : choice);
      if (read.rows.length < 2) {
        setNotice(t("im_empty"));
        setTable([]);
        return;
      }
      if (read.rows.length - 1 > IMPORT_MAX_ROWS) {
        setNotice(t("im_too_many", { n: read.rows.length - 1, max: IMPORT_MAX_ROWS }));
        setTable([]);
        return;
      }
      setDetected(read.encoding);
      setTable(read.rows);
      setMapping(matchColumns(read.rows[0] ?? []));
      setSkipped([]);
      setPage(0);
      setStep(1);
    } catch (error) {
      const code = error instanceof SpreadsheetError ? error.code : "xlsx";
      setNotice(code === "xls" ? t("im_xls_note") : code === "empty" ? t("im_empty") : t("im_xlsx_bad"));
      setTable([]);
    }
  }

  async function downloadTemplate(kind: "csv" | "xlsx") {
    const headersZh = templateHeaders("zh-TW");
    if (kind === "csv") {
      downloadBlob("condola-import-zh-TW.csv", new Blob([csvDocument([headersZh])], { type: "text/csv;charset=utf-8" }));
    } else {
      const bytesXlsx = await buildXlsx([headersZh]);
      downloadBlob(
        "condola-import-zh-TW.xlsx",
        new Blob([copyBytes(bytesXlsx)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      );
    }
    setNotice(t("im_tpl_done"));
  }

  function setField(column: number, field: ImportField | "") {
    if (!mapping) return;
    const next = { ...mapping };
    for (const key of IMPORT_FIELDS) if (next[key] === column) next[key] = null;
    if (field) next[field] = column;
    setMapping(next);
  }

  function columnField(column: number): ImportField | "" {
    if (!mapping) return "";
    return IMPORT_FIELDS.find((field) => mapping[field] === column) ?? "";
  }

  async function runDry() {
    setBusy(true);
    setNotice("");
    try {
      const result = await runBatched("dry", requestRows(sending));
      setDry(result);
      setStep(3);
    } catch (error) {
      setNotice(messageFrom(t, error));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function runCommit() {
    const blocked = new Set(dry.errors.map((issue) => issue.line));
    const rows = requestRows(sending.filter((row) => !blocked.has(row.line)));
    if (rows.length === 0) return;
    setBusy(true);
    setNotice("");
    try {
      const combined = await runBatched("commit", rows);
      setPreviewErrors(parsed.filter((row) => rowHasError(row)).flatMap((row) => row.issues.filter((issue) => issue.severity === "error")));
      setDone(combined);
      setStep(4);
    } catch (error) {
      setNotice(messageFrom(t, error));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function runBatched(mode: "dry" | "commit", rows: ImportRequestRow[]) {
    const combined = emptyResult(fileName);
    for (let offset = 0; offset < rows.length; offset += IMPORT_COMMIT_BATCH) {
      const batch = rows.slice(offset, offset + IMPORT_COMMIT_BATCH);
      setProgress(`${Math.min(offset + batch.length, rows.length)} / ${rows.length}`);
      mergeResult(combined, await postImport(mode, fileName, batch));
    }
    return combined;
  }

  function downloadErrors(extra: ImportIssue[]) {
    const issues = [...previewErrors, ...extra.filter((issue) => issue.severity === "error")];
    const unique = new Map<string, ImportIssue>();
    for (const issue of issues) unique.set(`${issue.line}:${issue.key}`, issue);
    const lines = [["列", "問題"], ...[...unique.values()].map((issue) => [String(issue.line), t(issue.key, issue.vars)])];
    downloadBlob("condola-import-errors.csv", new Blob([csvDocument(lines)], { type: "text/csv;charset=utf-8" }));
  }

  return (
    <div data-testid="import-wizard">
      <Stepper steps={steps} current={step + 1} />
      {notice ? (
        <div className="alert bad" data-testid="import-notice" style={{ margin: "12px 0" }}>
          {notice}
        </div>
      ) : null}

      {step === 0 ? (
        <div className="card pad">
          <h2>{t("im_up_h")}</h2>
          <p className="muted">{t("im_up_sub")}</p>
          <p className="small">{t("im_up_types")}</p>
          <p className="small">{t("im_local")}</p>
          <div className="row" style={{ margin: "12px 0" }}>
            <button className="btn" type="button" data-testid="import-template-zh" onClick={() => downloadTemplate("csv")}>
              {t("im_tpl_zh")}
            </button>
            <button className="btn" type="button" data-testid="import-template-xlsx" onClick={() => downloadTemplate("xlsx")}>
              {t("im_tpl_zh")} .xlsx
            </button>
            <button className="btn" type="button" data-testid="import-template-en" onClick={() => downloadBlob("condola-import-en.csv", new Blob([csvDocument([templateHeaders("en")])], { type: "text/csv;charset=utf-8" }))}>
              {t("im_tpl_en")}
            </button>
          </div>
          <ul className="small">
            <li>{t("im_tpl_r1")}</li>
            <li>{t("im_tpl_r2")}</li>
            <li>{t("im_tpl_r3")}</li>
            <li>{t("im_tpl_r4", { cap: 2 })}</li>
            <li>{t("im_tpl_r5")}</li>
          </ul>
          <label className="small" style={{ display: "block", marginTop: 12 }}>
            {t("im_enc")}
            <select
              className="inp"
              data-testid="import-encoding"
              value={encodingChoice}
              style={{ maxWidth: 220, marginLeft: 8 }}
              onChange={(event) => {
                const choice = event.target.value as "auto" | "utf-8" | "big5";
                setEncodingChoice(choice);
                if (bytes && fileName && !fileName.toLowerCase().endsWith(".xlsx")) {
                  const file = new File([copyBytes(bytes)], fileName);
                  void loadFile(file, choice);
                }
              }}
            >
              <option value="auto">{t("im_enc_auto")}</option>
              <option value="utf-8">UTF-8</option>
              <option value="big5">Big5 / CP950</option>
            </select>
          </label>
          <p className="small muted">{t("im_enc_hint")}</p>
          <input
            className="inp"
            data-testid="import-file"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ marginTop: 12 }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadFile(file, encodingChoice);
            }}
          />
        </div>
      ) : null}

      {step === 1 && mapping ? (
        <div className="card pad" data-testid="import-map">
          <h2>{t("im_map_h")}</h2>
          <p className="muted">{t("im_map_sub")}</p>
          <p data-testid="import-row-count">
            {t("im_rows_n", { n: Math.max(0, table.length - 1) })}
            {detected ? <span data-testid="import-encoding-value"> {detected}</span> : null}
          </p>
          {missing.length ? (
            <p className="alert bad" data-testid="import-map-missing">
              {t("im_map_miss", { n: missing.length })}
            </p>
          ) : (
            <p data-testid="import-map-missing">{t("im_map_miss", { n: 0 })}</p>
          )}
          <table className="t">
            <thead>
              <tr>
                <th>{t("im_map_col")}</th>
                <th>{t("im_map_field")}</th>
                <th>{t("im_map_ex")}</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((header, index) => (
                <tr key={`${header}-${index}`} data-testid="map-row">
                  <td data-testid="map-header">{header}</td>
                  <td>
                    <select
                      className="inp"
                      data-testid="map-select"
                      aria-label={header}
                      value={columnField(index)}
                      onChange={(event) => setField(index, event.target.value as ImportField | "")}
                    >
                      <option value="">{t("im_map_none")}</option>
                      {IMPORT_FIELDS.map((field) => (
                        <option key={field} value={field}>
                          {fieldLabel(field, "zh-TW")} / {fieldLabel(field, "en")}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="small muted">{sampleCells(table, index)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="button" onClick={() => setStep(0)}>
              {t("im_restart")}
            </button>
            <button className="btn pri" type="button" data-testid="import-to-preview" disabled={missing.length > 0} onClick={() => setStep(2)}>
              {t("im_pre_ok")}
            </button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="card pad" data-testid="import-preview">
          <h2>{t("im_pre_h")}</h2>
          <p data-testid="import-ok-count">{t("im_ok_n", { n: sending.length })}</p>
          <p data-testid="import-err-count">{t("im_err_n", { n: parsed.filter((row) => rowHasError(row)).length })}</p>
          <p>{t("im_warn_n", { n: parsed.filter((row) => row.issues.some((issue) => issue.severity === "warn")).length })}</p>
          <label className="small">
            <input type="checkbox" checked={onlyErrors} onChange={(event) => { setOnlyErrors(event.target.checked); setPage(0); }} /> {t("im_only_err")}
          </label>
          {problems.length === 0 ? <p>{t("im_none_err")}</p> : null}
          <table className="t">
            <thead>
              <tr>
                <th>{t("im_line")}</th>
                <th>{t("im_issues")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.line} data-testid="import-issue-row">
                  <td>{row.line}</td>
                  <td>
                    {row.issues.map((issue) => (
                      <div key={`${issue.key}-${issue.severity}`}>{t(issue.key, issue.vars)}</div>
                    ))}
                  </td>
                  <td>
                    {rowHasError(row) ? (
                      <button
                        className="btn sm"
                        type="button"
                        onClick={() => setSkipped((current) => (current.includes(row.line) ? current.filter((line) => line !== row.line) : [...current, row.line]))}
                      >
                        {skipSet.has(row.line) ? t("im_unskip") : t("im_skip")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">{t("im_page", { p: Math.min(page + 1, pageCount), n: pageCount })}</p>
          {unskippedErrors.length ? <p className="alert bad">{t("im_fix_first")}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="button" onClick={() => setStep(1)}>
              {t("im_s2")}
            </button>
            <button
              className="btn"
              type="button"
              data-testid="import-skip-all"
              onClick={() => setSkipped(parsed.filter((row) => rowHasError(row)).map((row) => row.line))}
            >
              {t("im_skip_all_err")}
            </button>
            <button className="btn pri" type="button" data-testid="import-to-dry" disabled={busy || unskippedErrors.length > 0} onClick={() => void runDry()}>
              {t("im_to_dry")}
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="card pad" data-testid="import-dry">
          <h2>{t("im_dry_h")}</h2>
          <p className="muted">{t("im_dry_sub")}</p>
          <p className="small">{t("im_dry_notes")}</p>
          <Summary result={dry} />
          {dry.errors.length ? <p>{t("im_dry_skip", { n: dry.errors.length })}</p> : null}
          {progress ? <p data-testid="import-progress">{progress}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="button" disabled={busy} onClick={() => setStep(2)}>
              {t("im_s3")}
            </button>
            <button
              className="btn pri"
              type="button"
              data-testid="import-run"
              disabled={busy || sending.filter((row) => !new Set(dry.errors.map((issue) => issue.line)).has(row.line)).length === 0}
              onClick={() => void runCommit()}
            >
              {t("im_run", { n: sending.filter((row) => !new Set(dry.errors.map((issue) => issue.line)).has(row.line)).length })}
            </button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="card pad" data-testid="import-result">
          <h2>{t("im_res_h")}</h2>
          <Summary result={done} />
          <p>{t("im_next_fee")}</p>
          <div className="row" style={{ marginTop: 12 }}>
            <Link className="btn" href="/m/properties" data-testid="import-go-props">
              {t("im_go_props")}
            </Link>
            <Link className="btn" href="/m/leases">
              {t("im_go_leases")}
            </Link>
            <button className="btn" type="button" data-testid="import-errors-csv" onClick={() => downloadErrors(done.errors)}>
              {t("im_err_n", { n: new Set([...previewErrors, ...done.errors].map((issue) => issue.line)).size })}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setStep(0);
                setTable([]);
                setMapping(null);
              }}
            >
              {t("im_again")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Summary({ result }: { result: ImportResult }) {
  const t = useT();
  return (
    <div data-testid="import-summary">
      <p>
        {t("im_c_props")} <b data-testid="import-count-properties">{result.created.properties}</b>
      </p>
      <p>
        {t("im_c_units")} <b data-testid="import-count-units">{result.created.units}</b>
      </p>
      <p>
        {t("im_c_rooms")} <b>{result.created.rooms}</b>
      </p>
      <p>
        {t("im_c_owners")} <b>{result.created.owners}</b>
      </p>
      <p>
        {t("im_c_tenants")} <b data-testid="import-count-tenants">{result.created.tenants}</b>
      </p>
      <p>
        {t("im_c_leases")} <b data-testid="import-count-leases">{result.created.leases}</b>
      </p>
      <p>
        {t("im_c_vacant")} <b>{result.created.vacant}</b>
      </p>
      <p data-testid="import-reused-units">{t("im_reused_units", { n: result.reused.units })}</p>
      <p data-testid="import-reused-tenants">{t("im_reused_tenants", { n: result.reused.tenants })}</p>
      <p data-testid="import-reused-leases">{t("im_reused_leases", { n: result.reused.leases })}</p>
    </div>
  );
}

function sampleCells(table: string[][], column: number) {
  return table
    .slice(1, 4)
    .map((row) => row[column] ?? "")
    .filter(Boolean)
    .join(" · ");
}

function requestRows(rows: ParsedImportRow[]): ImportRequestRow[] {
  return rows.map((row) => ({
    line: row.line,
    propertyName: row.propertyName,
    address: row.address,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail ?? "",
    rentalMode: row.kind === "room" ? "分租" : "整層",
    unitLabel: row.unitLabel,
    roomLabel: row.roomLabel ?? "",
    roomType: row.roomType,
    area: row.area === null ? "" : String(row.area),
    rent: String(row.rentMajor),
    tenantName: row.tenantName ?? "",
    tenantPhone: row.tenantPhone ?? "",
    tenantEmail: row.tenantEmail ?? "",
    tenantId: row.tenantId ?? "",
    startDate: row.startDate ?? "",
    endDate: row.endDate ?? "",
    deposit: row.lease ? String(row.depositMajor) : "",
    dueDay: row.dueDay === null ? "" : String(row.dueDay),
    electricity: row.electricity ?? "",
    rate: row.rate === null ? "" : String(row.rate),
    billKwh: row.billKwh === null ? "" : String(row.billKwh),
    billAmount: row.billAmountMinor === null ? "" : String(row.billAmountMinor / 100),
    opening: row.openingMinor ? String(row.openingMinor / 100) : "",
    depositReason: row.depositReason ?? "",
    rateReason: row.rateReason ?? "",
    notes: row.notes ?? "",
  }));
}

function emptyResult(fileName: string): ImportResult {
  return { ...EMPTY, dryRun: false, fileName, created: { ...EMPTY.created }, reused: { ...EMPTY.reused }, errors: [], warnings: [] };
}

function mergeResult(target: ImportResult, part: ImportResult) {
  target.created.properties += part.created.properties;
  target.created.units += part.created.units;
  target.created.rooms += part.created.rooms;
  target.created.owners += part.created.owners;
  target.created.tenants += part.created.tenants;
  target.created.leases += part.created.leases;
  target.created.vacant += part.created.vacant;
  target.reused.units += part.reused.units;
  target.reused.tenants += part.reused.tenants;
  target.reused.leases += part.reused.leases;
  target.openingMinor += part.openingMinor;
  target.errors.push(...part.errors);
  target.warnings.push(...part.warnings);
}

async function postImport(mode: "dry" | "commit", fileName: string, rows: ImportRequestRow[]) {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, fileName, rows }),
  });
  const body = (await response.json()) as ImportResult & { error?: string; vars?: Record<string, string | number> };
  if (!response.ok) throw body;
  return body;
}

function messageFrom(t: ReturnType<typeof useT>, error: unknown) {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: string; vars?: Record<string, string | number> };
    if (body.error) return t(body.error, body.vars);
  }
  return t("i_generic");
}

function copyBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
