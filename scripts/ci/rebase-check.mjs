#!/usr/bin/env node
/**
 * Fail unless HEAD already contains the latest base (default origin/main).
 * pull_request checkouts are merge commits, so CI checks the PR head ref.
 *
 *   git fetch origin main --no-tags
 *   node scripts/ci/rebase-check.mjs
 *   node scripts/ci/rebase-check.mjs --repo /path --base main
 *
 * Exit 0 when merge-base(HEAD, base) equals base, 1 when the branch is behind, 2 on bad usage.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function rebaseVerdict(head, mergeBase, main) {
  const upToDate = Boolean(head && mergeBase && main && mergeBase === main);
  return {
    upToDate,
    head: head || "",
    mergeBase: mergeBase || "",
    main: main || "",
  };
}

export function formatRebase(verdict) {
  const lines = [`HEAD ${verdict.head}`, `merge-base ${verdict.mergeBase}`, `origin/main ${verdict.main}`];
  if (verdict.upToDate) lines.push("rebase: up to date");
  else lines.push("This branch does not contain the latest origin/main. Rebase onto main and push again.");
  return lines.join("\n");
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

export function readRebase(repo, baseRef = "origin/main") {
  const head = git(repo, ["rev-parse", "HEAD"]);
  let main = "";
  try {
    main = git(repo, ["rev-parse", baseRef]);
  } catch {
    return rebaseVerdict(head, "", "");
  }
  let mergeBase = "";
  try {
    mergeBase = git(repo, ["merge-base", "HEAD", baseRef]);
  } catch {
    mergeBase = "";
  }
  return rebaseVerdict(head, mergeBase, main);
}

function main() {
  const args = process.argv.slice(2);
  let repo = process.cwd();
  let baseRef = "origin/main";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--base") {
      baseRef = args[index + 1] || "";
      index += 1;
      continue;
    }
    console.error("Usage: node scripts/ci/rebase-check.mjs [--repo path] [--base ref]");
    return 2;
  }
  if (!repo || !baseRef) {
    console.error("Usage: node scripts/ci/rebase-check.mjs [--repo path] [--base ref]");
    return 2;
  }
  let verdict;
  try {
    verdict = readRebase(repo, baseRef);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  console.log(formatRebase(verdict));
  return verdict.upToDate ? 0 : 1;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main());
