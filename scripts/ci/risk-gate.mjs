#!/usr/bin/env node
/**
 * Apply has-migration, high-risk, and copy-change from the diff.
 * Post the Product Marketing copy comment and the copy-ok / pm-full-accept statuses.
 * copy-ok and pm-full-accept are maintainer labels. This script never adds them
 * and never reads the pull request description.
 *
 *   node scripts/ci/risk-gate.mjs
 *   node scripts/ci/risk-gate.mjs --diff change.diff --dry-run
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDiff, COPY_COMMENT_MARKER, planActions, renderCopyComment } from "./classify-diff.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LABEL_COLORS = {
  "copy-change": "a16207",
  "has-migration": "1d4ed8",
  "high-risk": "b91c1c",
};

function gitDiff() {
  return execFileSync("git", ["-C", repoRoot, "diff", "--unified", "--find-renames", "origin/main...HEAD"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function pullRequestRef() {
  if (!process.env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pull = event.pull_request;
  if (!pull || !pull.number || !pull.head || !pull.head.sha) return null;
  return { number: pull.number, sha: pull.head.sha };
}

function summaryOf(classification, actions) {
  return {
    labels: classification.labels,
    hasMigration: classification.hasMigration,
    highRisk: classification.highRisk,
    copyChange: classification.copyChange,
    unclassified: classification.unclassified,
    reasons: classification.reasons,
    copyLines: classification.copyLines,
    actions,
  };
}

async function api(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await globalThis.fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "condola-risk-gate",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function ensureLabel(repo, name) {
  try {
    await api("POST", `/repos/${repo}/labels`, {
      name,
      color: LABEL_COLORS[name],
      description: "Applied by CI from the pull request diff.",
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

async function currentLabels(repo, number) {
  const labels = await api("GET", `/repos/${repo}/issues/${number}/labels?per_page=100`);
  return labels.map((label) => label.name);
}

async function syncComment(repo, number, classification) {
  const comments = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await api("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const existing = comments.find((comment) => String(comment.body || "").includes(COPY_COMMENT_MARKER));
  if (!classification.copyChange && !existing) return;
  const body = renderCopyComment(classification.copyChange ? classification.copyLines : []);
  if (existing) {
    if (existing.body !== body) await api("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
    return;
  }
  await api("POST", `/repos/${repo}/issues/${number}/comments`, { body });
}

async function publish(repo, number, sha, classification, actions) {
  if (actions.add.length > 0) {
    for (const name of actions.add) await ensureLabel(repo, name);
    await api("POST", `/repos/${repo}/issues/${number}/labels`, { labels: actions.add });
  }
  for (const name of actions.remove) {
    try {
      await api("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  await syncComment(repo, number, classification);
  for (const [context, status] of Object.entries(actions.statuses)) {
    await api("POST", `/repos/${repo}/statuses/${sha}`, {
      state: status.state,
      context,
      description: status.description,
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let diffPath = "";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--diff") {
      diffPath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    console.error("Usage: node scripts/ci/risk-gate.mjs [--diff file] [--dry-run]");
    process.exit(2);
  }

  const diffText = diffPath ? readFileSync(diffPath, "utf8") : gitDiff();
  const classification = classifyDiff(diffText);
  const preview = planActions(classification, []);
  if (dryRun || !process.env.GITHUB_EVENT_PATH || process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.log(JSON.stringify(summaryOf(classification, preview), null, 2));
    return;
  }

  const ref = pullRequestRef();
  if (!ref) {
    console.log(JSON.stringify(summaryOf(classification, preview), null, 2));
    return;
  }
  if (!process.env.GITHUB_TOKEN) {
    console.log(JSON.stringify(summaryOf(classification, preview), null, 2));
    console.error("GITHUB_TOKEN is missing. Review statuses were not posted.");
    process.exit(process.env.GITHUB_ACTIONS === "true" ? 1 : 0);
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const labels = await currentLabels(repo, ref.number);
  const actions = planActions(classification, labels);
  console.log(JSON.stringify(summaryOf(classification, actions), null, 2));
  await publish(repo, ref.number, ref.sha, classification, actions);
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

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
