/**
 * Unified-diff parser. Only diff headers and hunks are read.
 * Text before the first `diff --git` line is ignored, so a pull request
 * description cannot introduce a path.
 */

function tokenizeGitPaths(rest) {
  const tokens = [];
  let index = 0;
  while (index < rest.length) {
    while (rest[index] === " ") index += 1;
    if (index >= rest.length) break;
    if (rest[index] === '"') {
      let value = "";
      index += 1;
      while (index < rest.length && rest[index] !== '"') {
        if (rest[index] === "\\" && index + 1 < rest.length) {
          value += rest[index + 1];
          index += 2;
          continue;
        }
        value += rest[index];
        index += 1;
      }
      if (rest[index] === '"') index += 1;
      tokens.push(value);
      continue;
    }
    const start = index;
    while (index < rest.length && rest[index] !== " ") index += 1;
    tokens.push(rest.slice(start, index));
  }
  return tokens;
}

function stripAbbrev(path) {
  return path.replace(/^[ab]\//, "").trim();
}

function cleanMarkerPath(raw) {
  const path = raw.split("\t")[0].trim();
  if (path.startsWith('"') && path.endsWith('"')) return stripAbbrev(path.slice(1, -1));
  return stripAbbrev(path);
}

function beginFile(header) {
  const tokens = tokenizeGitPaths(header.slice("diff --git ".length));
  const oldPath = tokens[0] ? stripAbbrev(tokens[0]) : "";
  const path = tokens[1] ? stripAbbrev(tokens[1]) : oldPath;
  return { path, oldPath, added: [], removed: [], deleted: false };
}

export function parseDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = 0;
  let oldLine = 0;
  for (const line of String(diffText).split(/\n/)) {
    if (line.startsWith("diff --git ")) {
      current = beginFile(line);
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = cleanMarkerPath(line.slice(4));
      current.oldPath = path === "/dev/null" ? "" : path;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = cleanMarkerPath(line.slice(4));
      if (path === "/dev/null") current.deleted = true;
      else current.path = path;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      current.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.removed.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return files.filter((file) => file.path || file.oldPath);
}
