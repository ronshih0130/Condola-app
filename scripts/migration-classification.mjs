/** Examine only changed lines within diff hunks, including removals. */
export function commentOnly(diff) {
  let inHunk = false;
  const lines = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) lines.push(line.slice(1).trim());
  }
  return lines.length > 0 && lines.every((line) => line === "" || line.startsWith("--"));
}

/** Changed historical SQL cannot inherit an added-file classification. */
export function classifyMigration(status, diff, known) {
  if (status === "M" || status === "R") {
    if (commentOnly(diff)) return { addOnly: true, reason: "Version comment only. No column, default, trigger, function, NOT NULL, or constraint. An already applied filename is not run again." };
    throw new Error("modified historical migration requires explicit re-review");
  }
  if (status !== "A" || !known) throw new Error("no add-only classification");
  return known;
}
