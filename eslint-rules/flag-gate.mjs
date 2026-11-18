import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// eslint-rules/ lives at the repo root, so the directory above it is the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const allowlist = JSON.parse(readFileSync(path.join(here, "flag-gate-allowlist.json"), "utf8"));

// Hand-written flag predicates: isFooEnabled(...), fooEnabled(...), fooEnabledForOrg(...),
// fooGloballyEnabled(...), fooGlobalEnabled(...). Anchored to the whole callee identifier.
const FLAG_CALL = /^(is[A-Z]\w*Enabled|[a-z]\w*(EnabledForOrg|GloballyEnabled|GlobalEnabled|Enabled))$/;
const MESSAGE = "Hand-written flag check. Use withFlagGate from src/server/flag-gate.ts (AGENTS.md R5).";

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

// True when `node` is lexically inside the first argument (the spec object) of a withFlagGate(...) call.
function insideFlagGateSpec(node) {
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (
      parent.type === "CallExpression" &&
      calleeName(parent.callee) === "withFlagGate" &&
      parent.arguments[0] === child
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow hand-written feature-flag checks in src/app route/page code; use withFlagGate.",
    },
    schema: [],
    messages: { handwritten: MESSAGE },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const relPath = path.relative(repoRoot, filename).split(path.sep).join("/");
    const max = Object.prototype.hasOwnProperty.call(allowlist, relPath) ? allowlist[relPath] : undefined;
    const violations = [];

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !FLAG_CALL.test(name)) return;
        if (insideFlagGateSpec(node)) return;
        violations.push(node);
      },
      "Program:exit"() {
        if (max === undefined) {
          for (const node of violations) context.report({ node, messageId: "handwritten" });
          return;
        }
        // Frozen allowlist: anything beyond the ratcheted count is a new violation.
        if (violations.length > max) {
          for (const node of violations.slice(max)) context.report({ node, messageId: "handwritten" });
        }
      },
    };
  },
};

const plugin = { rules: { "flag-gate": rule } };
export default plugin;
export { rule };
