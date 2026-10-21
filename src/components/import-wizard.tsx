"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useT } from "./locale";
import { csvDocument, buildXlsx, readSpreadsheet, SpreadsheetError } from "@/lib/spreadsheet";
import {
  IMPORT_COMMIT_BATCH,
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  issuePreviewColumns,
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
  openingMinor: 0,
  errors: [],
  warnings: [],
};

export function ImportWizard() {
  const t = useT();
  const steps = [t("im_s1"), t("im_s2"), t("im_s3")];
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState("");
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [encodingChoice, setEncodingChoice] = useState<"auto" | "utf-8" | "big5">("auto");
  const [detected, setDetected] = useState("");
  const [table, setTable] = useState<string[][]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState<ImportResult>(EMPTY);
  const [serverErrors, setServerErrors] = useState<ImportIssue[]>([]);

  const mapping = useMemo(() => (table[0] ? matchColumns(table[0]) : null), [table]);
  const parsed = useMemo(() => (mapping ? validateImportRows(tableToRows(table, mapping)) : []), [mapping, table]);
  const missing = mapping ? missingRequired(mapping) : [];
  const problemRows = parsed.filter((row) => rowHasError(row));
  const validRows = parsed.filter((row) => !rowHasError(row));
  const preview = parsed.slice(0, PREVIEW_ROWS);
  const stepperAt = step >= 2 ? 3 : step + 1;

  async function loadFile(file: File, choice: "auto" | "utf-8" | "big5") {
    setNotice("");
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
        setStep(1);
        return;
      }
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
    const rows = requestRows(validRows);
    if (rows.length === 0 || missing.length > 0) return;
    setBusy(true);
    setNotice("");
    try {
      const combined = await runBatched("commit", rows);
      setServerErrors(combined.errors.filter((issue) => issue.severity === "error"));
      setDone(combined);
      setStep(3);
    } catch (error) {
      setNotice(messageFrom(t, error));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function runBatched(mode: "dry" | "commit", rows: ImportRequestRow[]) {
    const combined = emptyResult(fileName);
    const size = IMPORT_COMMIT_BATCH;
    for (let offset = 0; offset < rows.length; offset += size) {
      const batch = rows.slice(offset, offset + size);
      setProgress(`${Math.min(offset + batch.length, rows.length)} / ${rows.length}`);
      mergeResult(combined, await postImport(mode, fileName, batch));
    }
    return combined;
  }

  function downloadProblems() {
    const extra = new Map<number, string>();
    for (const issue of serverErrors) {
      const text = t(issue.key, issue.vars);
      extra.set(issue.line, extra.has(issue.line) ? `${extra.get(issue.line)}；${text}` : text);
    }
    const lines: string[][] = [[...(table[0] ?? []), t("im_problem_col")]];
    const seen = new Set<number>();
    for (const row of problemRows) {
      seen.add(row.line);
      const reason = row.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => t(issue.key, issue.vars))
        .join("；");
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
              {t("im_can")}{" "}
              <b className="import-ok" data-testid="import-ok-count">
                {validRows.length}
              </b>{" "}
              {t("im_unit")}、{t("im_problem")}{" "}
              <b className="import-danger" data-testid="import-err-count">
                {problemRows.length}
              </b>{" "}
              {t("im_unit")}
            </span>
          </div>
          <p className="small muted" data-testid="import-row-count">
            {t("im_preview_help")}{" "}
            <span data-testid="import-encoding-value">{detected}</span> {t("im_rows_n", { n: Math.max(0, table.length - 1) })}
          </p>
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
                  const status = rowStatus(row, t);
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
          {progress ? <p data-testid="import-progress">{progress}</p> : null}
          <div className="import-foot">
            <button className="btn" type="button" data-testid="import-errors-csv" disabled={problemRows.length === 0} onClick={downloadProblems}>
              {t("im_dl_problems")}
            </button>
            <button className="btn pri" type="button" data-testid="import-run" disabled={busy || validRows.length === 0} onClick={() => void runCommit()}>
              {t("im_run", { n: validRows.length })}
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="card pad" data-testid="import-result">
          <h2>{t("im_res_h")}</h2>
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

function rowStatus(row: ParsedImportRow, t: ReturnType<typeof useT>) {
  const error = row.issues.find((issue) => issue.severity === "error");
  if (!error) return { ok: true, text: t("im_row_ok") };
  const field = String(error.vars?.f ?? "");
  if (error.key === "im_e_req" && (field === "月租" || field === "Rent")) return { ok: false, text: t("im_rent_blank") };
  return { ok: false, text: t("im_row_bad", { reason: t(error.key, error.vars) }) };
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
