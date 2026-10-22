/**
 * Pull-request labels computed from a unified diff.
 *
 * has-migration, high-risk, and copy-change come from paths and changed lines.
 * classifyDiff takes the diff text only. A pull request description is not an input.
 * A changed file that matches no rule is high-risk.
 */
import { parseDiff } from "./parse-diff.mjs";

export const AUTO_LABELS = ["copy-change", "has-migration", "high-risk"];
export const APPROVAL_LABELS = ["copy-ok", "pm-full-accept"];
export const COPY_COMMENT_MARKER = "<!-- condola-copy-review -->";
const COPY_LINE_CAP = 200;

const PROMISE_RULES = [
  ["promise-price", /NT\$|US\$|\bUSD\b|\bTWD\b|＄|\$\s?\d|\d[\d,]*\s*元/],
  ["promise-refund", /退款|退費|\brefunds?\b/i],
  ["promise-retention", /(?:保留|保存|存留|retention).{0,16}\d+\s*(?:天|日|days?)|\d+\s*(?:天|日|days?).{0,16}(?:保留|保存|刪除|銷毀|retention)|資料保留|data retention/i],
  ["promise-security", /保證.{0,8}安全|不會外洩|絕不外洩|不會外流|銀行級|安全無虞/],
];

function baseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function isTestPath(path) {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  if (/(^|\/)e2e\//.test(path)) return true;
  if (path.startsWith("scripts/ci/fixtures/")) return true;
  return false;
}

function isRlsPath(path) {
  return /(^|\/)[^/]*rls[^/]*\.(sql|tsx?)$/.test(path);
}

function isIdPath(path) {
  const base = baseName(path);
  if (/^(id-hash|ids|privacy|ticket-photos|owner-import)(\.(test|spec))?\.tsx?$/.test(base)) return true;
  return /identity-document|personal-data|id-document/.test(path);
}

function isPurgePath(path) {
  const base = baseName(path).replace(/\.(tsx?|jsx?|sql|mjs)$/, "");
  if (/purge|deactivate/i.test(base)) return true;
  if (/(^|[^a-z])delete([^a-z]|$)/i.test(base)) return true;
  if (/(^|\/)(purge|delete)(\/|$)/.test(path)) return true;
  return false;
}

function isPermissionPath(path) {
  const base = baseName(path);
  if (/^(perms|org-scope|org-country)(\.(test|spec))?\.tsx?$/.test(base)) return true;
  if (base === "rpc-allowlist.txt") return true;
  if (/(^|\/)permissions?\//.test(path)) return true;
  if (/org-isolation/.test(path)) return true;
  return false;
}

function isBillingPath(path) {
  return (
    /(^|\/)billing\.(tsx?|(test|spec)\.tsx?)$/.test(path) ||
    /(^|\/)pricing-calculator\.tsx$/.test(path) ||
    /(^|\/)pricing\.tsx?$/.test(path) ||
    /(^|\/)pricing\//.test(path) ||
    /(^|\/)upgrade-gate\.(test\.)?tsx?$/.test(path) ||
    /(^|\/)partners\.ts$/.test(path) ||
    /(^|\/)upgrade\//.test(path)
  );
}

function isLegalPath(path) {
  if (path.startsWith("src/assets/leases/")) return true;
  return /(^|\/)(legal|terms|privacy)(\/|\/?page\.tsx$|\.(md|html|txt)$)/.test(path);
}

function pathRules(path) {
  const rules = [];
  if (path.startsWith("supabase/migrations/")) rules.push("migration");
  if (isRlsPath(path)) rules.push("rls");
  if (isIdPath(path)) rules.push("id-document");
  if (isPurgePath(path)) rules.push("delete-purge");
  if (isPermissionPath(path)) rules.push("permission");
  if (isBillingPath(path)) rules.push("billing");
  if (isLegalPath(path)) rules.push("legal");
  return rules;
}

function isWholeCopyFile(path) {
  if (isTestPath(path)) return false;
  if (/^src\/i18n\/.+\.json$/.test(path)) return true;
  if (path.startsWith("design/strings/")) return true;
  if (/(^|\/)messages\/.+\.(json|md|txt|html)$/.test(path)) return true;
  if (/(^|\/)(mail-copy|line-copy)\.(tsx?|jsx?)$/.test(path)) return true;
  if (/email-template/.test(path) || /(^|\/)emails\/.+\.(html|txt|mjml|hbs)$/.test(path)) return true;
  if (path.startsWith("src/assets/leases/")) return true;
  if (/\.(md|html|txt)$/.test(path) && /(^|\/)(legal|terms|privacy)(\/|\.)/.test(path)) return true;
  return false;
}

function isUiFile(path) {
  if (isTestPath(path)) return false;
  return /^src\/(app|components)\/.+\.(tsx|jsx)$/.test(path);
}

function stringLiterals(line) {
  const literals = [];
  const pattern = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match = pattern.exec(line);
  while (match) {
    literals.push(match[2]);
    match = pattern.exec(line);
  }
  return literals;
}

function visibleProse(text) {
  if (/[\u3400-\u9fff]/.test(text)) return true;
  if (!/[A-Za-z]/.test(text) || !/\s/.test(text)) return false;
  if (/^[a-z0-9_:/.[\] -]+$/.test(text)) return false;
  return /[A-Za-z]{3,}/.test(text);
}

export function promiseRules(text) {
  const hits = [];
  for (const [rule, pattern] of PROMISE_RULES) {
    if (pattern.test(text)) hits.push(rule);
  }
  return hits;
}

function isUiTextLine(line) {
  if (/^\s*(import|export)\s/.test(line)) return false;
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
  if (/\bt\(\s*["'`]/.test(line)) return true;
  const jsx = />\s*([^<>{}]+?)\s*</.exec(line);
  if (jsx && (visibleProse(jsx[1]) || promiseRules(jsx[1]).length > 0)) return true;
  for (const literal of stringLiterals(line)) {
    if (visibleProse(literal) || promiseRules(literal).length > 0) return true;
  }
  if (/[\u3400-\u9fff]/.test(line)) return true;
  return promiseRules(line).length > 0;
}

function changedRows(file) {
  return [
    ...file.added.map((row) => ({ ...row, kind: "added" })),
    ...file.removed.map((row) => ({ ...row, kind: "removed" })),
  ];
}

function copyLinesFor(file) {
  const paths = [file.path, file.oldPath].filter(Boolean);
  if (paths.some(isTestPath)) return [];
  const rows = changedRows(file).filter((row) => row.text.trim() !== "");
  const whole = paths.some(isWholeCopyFile);
  const ui = paths.some(isUiFile);
  if (!whole && !ui) return [];
  const picked = whole ? rows : rows.filter((row) => isUiTextLine(row.text));
  return picked.map((row) => ({
    path: file.deleted ? file.oldPath || file.path : file.path,
    line: row.line,
    kind: row.kind,
    text: row.text,
  }));
}

function sqlCode(line) {
  return line.replace(/--.*$/, "").replace(/'(?:[^']|'')*'/g, "''");
}

function contentRules(file, copyLines) {
  const paths = [file.path, file.oldPath].filter(Boolean);
  if (paths.some(isTestPath)) return [];
  const hits = [];
  const sql = paths.some((path) => path.endsWith(".sql"));
  for (const row of file.added) {
    if (sql) {
      const code = sqlCode(row.text);
      if (/\b(CREATE|ALTER|DROP)\s+POLICY\b/i.test(code) || /\bROW\s+LEVEL\s+SECURITY\b/i.test(code)) {
        hits.push({ rule: "rls", line: row.line });
      }
      if (/\b(GRANT|REVOKE)\b/i.test(code)) hits.push({ rule: "grant-revoke", line: row.line });
      if (/\bSECURITY\s+DEFINER\b/i.test(code)) hits.push({ rule: "security-definer", line: row.line });
    }
    if (/\bpurge[_A-Za-z0-9]*\s*\(|\bfunction\s+purge[_A-Za-z0-9]*|\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[^\s(]*purge/i.test(sqlCode(row.text))) {
      hits.push({ rule: "delete-purge", line: row.line });
    }
  }
  for (const row of copyLines) {
    if (row.kind !== "added") continue;
    for (const rule of promiseRules(row.text)) hits.push({ rule, line: row.line });
  }
  return hits;
}

export function classifyDiff(diffText) {
  const reasons = [];
  const copyLines = [];
  const unclassified = [];
  for (const file of parseDiff(diffText)) {
    const displayPath = file.deleted ? file.oldPath || file.path : file.path;
    const paths = [...new Set([file.path, file.oldPath].filter(Boolean))];
    const copies = copyLinesFor(file);
    // Fixture diffs are test input. A name like purge-path.diff is not a purge path.
    const fromPath = [...new Set(paths.filter((path) => !path.startsWith("scripts/ci/fixtures/")).flatMap(pathRules))];
    const fromContent = contentRules(file, copies);
    const high = fromPath.length > 0 || fromContent.length > 0;
    const known = high || copies.length > 0 || paths.some(isTestPath);
    if (!known) {
      unclassified.push(displayPath);
      reasons.push({ path: displayPath, rule: "unclassified" });
    }
    for (const rule of fromPath) reasons.push({ path: displayPath, rule });
    for (const hit of fromContent) reasons.push({ path: displayPath, line: hit.line, rule: hit.rule });
    copyLines.push(...copies);
  }

  const hasMigration = reasons.some((reason) => reason.rule === "migration");
  const highRisk = reasons.length > 0;
  const copyChange = copyLines.length > 0;
  const labels = [];
  if (copyChange) labels.push("copy-change");
  if (hasMigration) labels.push("has-migration");
  if (highRisk) labels.push("high-risk");
  return { labels, hasMigration, highRisk, copyChange, unclassified, reasons, copyLines };
}

export function renderCopyComment(copyLines) {
  const shown = copyLines.slice(0, COPY_LINE_CAP);
  const rows = shown.map((entry) => {
    const mark = entry.kind === "added" ? "+" : "-";
    const text = entry.text.trim().replace(/\s+/g, " ").slice(0, 180);
    return `- \`${entry.path}:${entry.line}\` \`${mark} ${text}\``;
  });
  const hidden = copyLines.length > COPY_LINE_CAP ? `\n\n${copyLines.length - COPY_LINE_CAP} more changed lines are not listed.` : "";
  const list = rows.length > 0 ? rows.join("\n") : "_No user-facing lines in the latest diff._";
  return [
    COPY_COMMENT_MARKER,
    "## User-facing copy for Product Marketing review",
    "",
    "These lines were computed from the diff. The pull request description is not a source.",
    "The `copy-ok` status stays pending until a maintainer applies the `copy-ok` label.",
    "",
    list,
    hidden,
    "",
  ].join("\n");
}

function statusText(name, state, required) {
  if (state === "pending") return `Pending until a maintainer applies ${name}`.slice(0, 140);
  if (required) return `Maintainer label ${name} is applied`.slice(0, 140);
  return "Not required for this diff";
}

export function planActions(classification, currentLabels) {
  const want = new Set(classification.labels);
  const current = new Set(currentLabels);
  const copyPending = classification.copyChange && !current.has("copy-ok");
  const riskPending = classification.highRisk && !current.has("pm-full-accept");
  return {
    add: AUTO_LABELS.filter((label) => want.has(label) && !current.has(label)),
    remove: AUTO_LABELS.filter((label) => !want.has(label) && current.has(label)),
    statuses: {
      "copy-ok": {
        state: copyPending ? "pending" : "success",
        description: statusText("copy-ok", copyPending ? "pending" : "success", classification.copyChange),
      },
      "pm-full-accept": {
        state: riskPending ? "pending" : "success",
        description: statusText("pm-full-accept", riskPending ? "pending" : "success", classification.highRisk),
      },
    },
  };
}
