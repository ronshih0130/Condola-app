"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { claimFormSubmit, releaseFormSubmit } from "./submit-once";
import { useLocale, useT } from "./locale";
import { csvDocument, buildXlsx, readSpreadsheet, SpreadsheetError } from "@/lib/spreadsheet";
import {
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  IMPORT_PREVIEW_BATCH,
  formatImportIssueMessage,
  issuePreviewColumns,
  ignoredNationalIdHeaders,
  matchColumns,
  missingRequired,
  previewBadColumns,
  rowHasError,
  tableToRows,
  templateHeaders,
  validateImportRows,
  type ImportIssue,
  type ImportRequestRow,
  type ImportResult,
  type ParsedImportRow,
  type PreviewColumn,
} from "@/server/owner-import";

const PREVIEW_ROWS = 5;

const EMPTY: ImportResult = {
  dryRun: true,
  fileName: "",
  created: { properties: 0, units: 0, rooms: 0, owners: 0, tenants: 0, leases: 0, vacant: 0 },
  reused: { units: 0, tenants: 0, leases: 0 },
  duplicateRows: 0,
  openingMinor: 0,
  errors: [],
  warnings: [],
};

export function ImportWizard() {
  const t = useT();
  const locale = useLocale();
  const steps = [t("im_s1"), t("im_s2"), t("im_s3")];
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState("");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [encodingChoice, setEncodingChoice] = useState<"auto" | "utf-8" | "big5">("auto");
  const [detected, setDetected] = useState("");
  const [table, setTable] = useState<string[][]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewDone, setPreviewDone] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState<ImportResult>(EMPTY);
  const [serverIssues, setServerIssues] = useState<ImportIssue[]>([]);
  const [serverErrors, setServerErrors] = useState<ImportIssue[]>([]);
  const submitGuard = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const mapping = useMemo(() => (table[0] ? matchColumns(table[0]) : null), [table]);
  const ignoredIds = useMemo(() => ignoredNationalIdHeaders(table[0] ?? []), [table]);
  const parsed = useMemo(() => (mapping ? validateImportRows(tableToRows(table, mapping)) : []), [mapping, table]);
  const missing = mapping ? missingRequired(mapping) : [];
  const serverByLine = useMemo(() => {
    const map = new Map<number, ImportIssue[]>();
    for (const issue of serverIssues) {
      const list = map.get(issue.line) ?? [];
      list.push(issue);
      map.set(issue.line, list);
    }
    return map;
  }, [serverIssues]);
  const viewed = useMemo(
    () =>
      parsed.map((row) => {
        const extra = serverByLine.get(row.line);
        if (!extra?.length) return row;
        return { ...row, issues: [...row.issues, ...extra] };
      }),
    [parsed, serverByLine],
  );
  const problemRows = viewed.filter((row) => rowHasError(row));
  const sendable = viewed.filter((row) => !rowHasError(row));
  const importable = sendable.filter((row) => !row.issues.some((issue) => issue.key === "im_row_exists"));
  const importableCount = importable.length;
  const preview = viewed.slice(0, PREVIEW_ROWS);
  const stepperAt = step >= 2 ? 3 : step + 1;
  const canRun = previewDone && !busy && !previewing && !previewFailed && importableCount > 0;

  useEffect(() => {
    if (step !== 2) return;
    const headers = table[0];
    if (!headers) return;
    const matched = matchColumns(headers);
    if (missingRequired(matched).length) return;
    const rows = validateImportRows(tableToRows(table, matched)).filter((row) => !rowHasError(row));
    let cancelled = false;
    setPreviewing(true);
    setPreviewDone(false);
    setPreviewFailed(false);
    setServerIssues([]);
    if (rows.length === 0) {
      setPreviewing(false);
      setPreviewDone(true);
      return;
    }
    void (async () => {
      const found: ImportIssue[] = [];
      for (let offset = 0; offset < rows.length; offset += IMPORT_PREVIEW_BATCH) {
        const issues = await postPreview(fileName, requestRows(rows.slice(offset, offset + IMPORT_PREVIEW_BATCH)));
        found.push(...issues);
      }
      if (!cancelled) {
        setServerIssues(found);
        setPreviewDone(true);
      }
    })()
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewFailed(true);
        setNotice(messageFrom(tRef.current, error));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, table, fileName]);

  async function loadFile(file: File, choice: "auto" | "utf-8" | "big5") {
    setNotice("");
    setFailed(false);
    setPreviewFailed(false);
    setPreviewDone(false);
    setProgress("");
    setServerIssues([]);
    setServerErrors([]);
    const buffer = new Uint8Array(await file.arrayBuffer());
    setBytes(buffer);
    setFileName(file.name);
    try {
      const read = await readSpreadsheet(file.name, buffer, file.name.toLowerCase().endsWith(".xlsx") ? "auto" : choice);
      if (read.rows.length < 2) {
        setNotice(t("im_empty"));
        setTable([]);
        setStep(1);
        return;
      }
      if (read.rows.length - 1 > IMPORT_MAX_ROWS) {
        setNotice(t("im_too_many", { n: read.rows.length - 1, max: IMPORT_MAX_ROWS }));
        setTable([]);
        setStep(1);
        return;
      }
      const matched = matchColumns(read.rows[0] ?? []);
      const absent = missingRequired(matched);
      setDetected(read.encoding);
      setTable(read.rows);
      if (absent.length) {
        setNotice(t("im_map_miss", { n: absent.length }));
        setPreviewing(false);
        setStep(1);
        return;
      }
      setPreviewing(true);
      setStep(2);
    } catch (error) {
      const code = error instanceof SpreadsheetError ? error.code : "xlsx";
      setNotice(code === "xls" ? t("im_xls_note") : code === "empty" ? t("im_empty") : t("im_xlsx_bad"));
      setTable([]);
      setStep(1);
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

  async function runCommit() {
    if (!claimFormSubmit(submitGuard)) return;
    const rows = requestRows(importable);
    if (rows.length === 0 || missing.length > 0 || !previewDone || previewing || previewFailed) {
      releaseFormSubmit(submitGuard);
      return;
    }
    setBusy(true);
    setFailed(false);
    setNotice("");
    setProgress(t("im_progress_n", { done: 0, total: rows.length }));
    try {
      const result = await postImport("commit", fileName, rows, (doneRows, total) => {
        setProgress(t("im_progress_n", { done: doneRows, total }));
      });
      const errors = result.errors.filter((issue) => issue.severity === "error");
      setServerErrors(errors);
      const created =
        result.created.properties +
        result.created.units +
        result.created.rooms +
        result.created.leases +
        result.created.tenants +
        result.created.owners;
      if (errors.length > 0 && created === 0 && result.duplicateRows === 0) {
        setFailed(true);
        setNotice(t("im_none"));
        setProgress("");
        return;
      }
      setDone(result);
      setProgress("");
      setStep(3);
    } catch {
      setFailed(true);
      setNotice(t("im_none"));
      setProgress("");
    } finally {
      setBusy(false);
      releaseFormSubmit(submitGuard);
    }
  }

  function downloadProblems() {
    const extra = new Map<number, string>();
    for (const issue of [...serverIssues, ...serverErrors]) {
      if (issue.severity !== "error") continue;
      const text = describeIssue(issue, t, locale);
      extra.set(issue.line, extra.has(issue.line) ? `${extra.get(issue.line)}；${text}` : text);
    }
    const lines: string[][] = [[...(table[0] ?? []), t("im_problem_col")]];
    const seen = new Set<number>();
    for (const row of problemRows) {
      seen.add(row.line);
      const reason = describeRowErrors(row, t, locale);
      lines.push([...(table[row.line - 1] ?? []), reason]);
    }
    for (const [line, reason] of extra) {
      if (seen.has(line)) continue;
      lines.push([...(table[line - 1] ?? []), reason]);
    }
    downloadBlob("condola-import-errors.csv", new Blob([csvDocument(lines)], { type: "text/csv;charset=utf-8" }));
  }

  return (
    <div data-testid="import-wizard">
      <div className="import-steps" aria-label={t("im_title")}>
        {steps.map((label, index) => {
          const number = index + 1;
          const done = number < stepperAt;
          const on = number === stepperAt;
          return (
            <div key={label} className={`st${on ? " on" : ""}${done ? " done" : ""}`}>
              <b>{done ? "✓" : number}</b>
              {label}
            </div>
          );
        })}
      </div>
      {notice ? (
        <div className="alert bad" data-testid="import-notice" style={{ margin: "12px 0" }}>
          {notice}
          {failed && !busy ? (
            <button className="btn" type="button" data-testid="import-retry" style={{ marginLeft: 12 }} onClick={() => void runCommit()}>
              {t("im_retry")}
            </button>
          ) : null}
        </div>
      ) : null}

      {step === 0 ? (
        <div className="card pad">
          <h2>{t("im_s1")}</h2>
          <p className="muted">{t("im_tpl_sub")}</p>
          <p className="small">{t("im_up_types")}</p>
          <div className="row" style={{ margin: "12px 0" }}>
            <button className="btn" type="button" data-testid="import-template-zh" onClick={() => downloadTemplate("csv")}>
              {t("im_tpl_zh")}
            </button>
            <button className="btn" type="button" data-testid="import-template-xlsx" onClick={() => downloadTemplate("xlsx")}>
              {t("im_tpl_zh")} .xlsx
            </button>
            <button
              className="btn"
              type="button"
              data-testid="import-template-en"
              onClick={() => downloadBlob("condola-import-en.csv", new Blob([csvDocument([templateHeaders("en")])], { type: "text/csv;charset=utf-8" }))}
            >
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
          <div className="import-foot">
            <span />
            <button className="btn pri" type="button" data-testid="import-to-upload" onClick={() => setStep(1)}>
              {t("im_next_upload")}
            </button>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="card pad" data-testid="import-upload">
          <h2>{t("im_s2")}</h2>
          <p className="muted">{t("im_up_sub")}</p>
          <p className="small">{t("im_local")}</p>
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
          {missing.length && table.length ? (
            <p className="alert bad" data-testid="import-map-missing" style={{ marginTop: 12 }}>
              {t("im_map_miss", { n: missing.length })}
            </p>
          ) : null}
          <div className="import-foot">
            <button className="btn" type="button" onClick={() => setStep(0)}>
              {t("im_s1")}
            </button>
            <span />
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="card pad" data-testid="import-preview">
          <div className="import-preview-hd">
            <b>{fileName}</b>
            <button className="btn sm" type="button" data-testid="import-restart" onClick={() => setStep(1)}>
              {t("im_restart")}
            </button>
            <span>
              {previewDone ? (
                <>
                  {t("im_can")}{" "}
                  <b className="import-ok" data-testid="import-ok-count">
                    {importableCount}
                  </b>{" "}
                  {t("im_unit")}、
                </>
              ) : (
                <span data-testid="import-checking">{t("im_checking")}</span>
              )}
              {previewDone ? null : "、"}
              {t("im_problem")}{" "}
              <b className="import-danger" data-testid="import-err-count">
                {problemRows.length}
              </b>{" "}
              {t("im_unit")}
            </span>
          </div>
          <p data-testid="import-row-summary">
            {t("im_ok_n", { n: Math.max(0, viewed.length - problemRows.length) })}
            {" · "}
            {t("im_err_n", { n: problemRows.length })}
          </p>
          {problemRows.length ? (
            <ul className="import-errors" data-testid="import-error-list">
              {problemRows.map((row) => (
                <li key={row.line} data-testid="import-error-item">
                  {describeRowErrors(row, t, locale)}
                </li>
              ))}
            </ul>
          ) : null}
          {previewDone && importableCount === 0 ? (
            <p className="alert" data-testid="import-nothing" role="status">
              {t("im_nothing")}
            </p>
          ) : null}
          <p className="small muted" data-testid="import-row-count">
            {t("im_preview_help")}{" "}
            <span data-testid="import-encoding-value">{detected}</span> {t("im_rows_n", { n: Math.max(0, table.length - 1) })}
          </p>
          {ignoredIds.length ? (
            <p className="alert" data-testid="import-ignored-id">
              {t("im_ignored", { cols: ignoredIds.join("、") })}
            </p>
          ) : null}
          <div style={{ overflowX: "auto" }}>
            <table className="t" data-testid="import-preview-table">
              <thead>
                <tr>
                  <th>{t("im_col_status")}</th>
                  <th>{t("im_col_property")}</th>
                  <th>{t("im_col_space")}</th>
                  <th>{t("im_col_tenant")}</th>
                  <th>{t("im_col_rent")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row) => {
                  const bad = previewBadColumns(row);
                  const status = rowStatus(row, t, locale, previewDone);
                  return (
                    <tr key={row.line} data-testid="import-issue-row" data-line={row.line}>
                      <td className={status.ok ? "import-ok" : "import-warn"}>{status.text}</td>
                      <PreviewCell
                        bad={bad.has("property")}
                        title={cellTitle(row, "property", t)}
                        text={shownCell(cellText(table, mapping, row.line, "propertyName"), bad.has("property"), t("im_blank"))}
                      />
                      <PreviewCell
                        bad={bad.has("space")}
                        title={cellTitle(row, "space", t)}
                        text={shownCell(spaceText(table, mapping, row), bad.has("space"), t("im_blank"))}
                      />
                      <PreviewCell
                        bad={bad.has("tenant")}
                        title={cellTitle(row, "tenant", t)}
                        text={shownCell(cellText(table, mapping, row.line, "tenantName"), bad.has("tenant"), t("im_blank"))}
                      />
                      <PreviewCell
                        bad={bad.has("rent")}
                        title={cellTitle(row, "rent", t)}
                        text={shownCell(cellText(table, mapping, row.line, "rent"), bad.has("rent"), t("im_blank"))}
                      />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {progress ? (
            <p data-testid="import-progress" role="status">
              {progress}
            </p>
          ) : null}
          <div className="import-foot">
            <button className="btn" type="button" data-testid="import-errors-csv" disabled={problemRows.length === 0} onClick={downloadProblems}>
              {t("im_dl_problems")}
            </button>
            <button className="btn pri" type="button" data-testid="import-run" disabled={busy || !canRun} onClick={() => void runCommit()}>
              {importableCount > 0 ? t("im_run", { n: importableCount }) : t("im_run_empty")}
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="card pad" data-testid="import-result">
          <h2>{t("im_res_h")}</h2>
          {ignoredIds.length ? (
            <p className="alert" data-testid="import-ignored-id">
              {t("im_ignored", { cols: ignoredIds.join("、") })}
            </p>
          ) : null}
          {done.duplicateRows > 0 ? (
            <p className="alert" data-testid="import-duplicate-notice">
              {done.created.properties + done.created.units + done.created.rooms + done.created.leases + done.created.tenants + done.created.owners === 0
                ? t("im_already")
                : t("im_dup_some", { n: done.duplicateRows })}
            </p>
          ) : null}
          <Summary result={done} />
          <p>{t("im_next_fee")}</p>
          {serverErrors.length ? <p data-testid="import-server-errors">{t("im_err_n", { n: new Set(serverErrors.map((issue) => issue.line)).size })}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <Link className="btn" href="/m/properties" data-testid="import-go-props">
              {t("im_go_props")}
            </Link>
            <Link className="btn" href="/m/leases">
              {t("im_go_leases")}
            </Link>
            <button className="btn" type="button" data-testid="import-errors-csv" onClick={downloadProblems}>
              {t("im_dl_problems")}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setStep(0);
                setTable([]);
                setBytes(null);
                setServerErrors([]);
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

function PreviewCell({ bad, title, text }: { bad: boolean; title: string; text: string }) {
  return (
    <td className={bad ? "import-bad" : undefined} title={bad ? title : undefined} data-testid={bad ? "import-bad-cell" : undefined}>
      {text}
    </td>
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

function describeIssue(issue: ImportIssue, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>) {
  const parts = formatImportIssueMessage(issue, locale, t(issue.key, issue.vars), t("im_blank"));
  const column = parts.column || t("im_unknown_col");
  return t("im_row_detail", { ...parts, column });
}

function describeRowErrors(row: ParsedImportRow, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>) {
  return row.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => describeIssue(issue, t, locale))
    .join("；");
}

function rowStatus(row: ParsedImportRow, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>, checked: boolean) {
  const error = row.issues.find((issue) => issue.severity === "error");
  if (!checked && !error) return { ok: false, text: t("im_checking") };
  if (!error && row.issues.some((issue) => issue.key === "im_row_exists")) return { ok: false, text: t("im_already") };
  if (!error) return { ok: true, text: t("im_row_ok") };
  return { ok: false, text: describeRowErrors(row, t, locale) };
}

function cellTitle(row: ParsedImportRow, column: PreviewColumn, t: ReturnType<typeof useT>) {
  const issue = row.issues.find((item) => item.severity === "error" && issuePreviewColumns(item).includes(column));
  if (!issue) return t("im_cell_required");
  if (issue.key === "im_e_req") return t("im_cell_required");
  return t(issue.key, issue.vars);
}

function cellText(
  table: string[][],
  mapping: ReturnType<typeof matchColumns> | null,
  line: number,
  field: (typeof IMPORT_FIELDS)[number],
) {
  if (!mapping) return "";
  const index = mapping[field];
  if (index === null || index === undefined) return "";
  return String(table[line - 1]?.[index] ?? "").trim();
}

function spaceText(table: string[][], mapping: ReturnType<typeof matchColumns> | null, row: ParsedImportRow) {
  return [cellText(table, mapping, row.line, "unitLabel"), cellText(table, mapping, row.line, "roomLabel")].filter(Boolean).join(" ");
}

function shownCell(value: string, bad: boolean, blankLabel: string) {
  if (!value && bad) return blankLabel;
  return value;
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

async function postPreview(fileName: string, rows: ImportRequestRow[]) {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "preview", fileName, rows }),
  });
  const body = (await response.json()) as { issues?: ImportIssue[]; error?: string; vars?: Record<string, string | number> };
  if (!response.ok) throw body;
  return body.issues ?? [];
}

async function postImport(
  mode: "commit",
  fileName: string,
  rows: ImportRequestRow[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportResult> {
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, fileName, rows }),
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({ error: "im_none" }));
    throw body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ImportResult | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type?: string;
      done?: number;
      total?: number;
      result?: ImportResult;
      error?: string;
    };
    if (event.type === "progress" && typeof event.done === "number" && typeof event.total === "number") {
      onProgress(event.done, event.total);
      return;
    }
    if (event.type === "result" && event.result) {
      result = event.result;
      return;
    }
    if (event.type === "error") throw event;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!result) throw { error: "im_none" };
  return result;
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
