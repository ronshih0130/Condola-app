import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Linter } from "eslint";

// eslint-rules/ lives at the repo root, so the directory above it is the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// Allowlist is loaded at module init. Missing file => empty map (every file gets allowance 0),
// which fails closed: the rule errors on any hand-written check until the allowlist is regenerated
// with `node eslint-rules/regen-flag-gate-allowlist.mjs`.
function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(path.join(here, "flag-gate-allowlist.json"), "utf8"));
  } catch {
    return {};
  }
}
const allowlist = loadAllowlist();

// Hand-written flag predicates: isFooEnabled(...), fooEnabled(...), fooEnabledForOrg(...),
// fooGloballyEnabled(...), fooGlobalEnabled(...). Anchored to the whole callee/imported name.
const FLAG_CALL = /^(is[A-Z]\w*Enabled|[a-z]\w*(EnabledForOrg|GloballyEnabled|GlobalEnabled|Enabled))$/;
const MESSAGE = "Hand-written flag check. Use withFlagGate from src/server/flag-gate.ts (AGENTS.md R5).";

// "@/server/flag-gate" or any relative/aliased path ending in "/flag-gate" (or a bare "flag-gate").
function isFlagGateModule(source) {
  return source === "@/server/flag-gate" || /(^|\/)flag-gate$/.test(source);
}

// Build name-sets from the module's import declarations.
//   importedMatchLocals : local binding names whose IMPORTED name matches FLAG_CALL  (case a)
//   nsOrDefaultLocals   : local names bound to a namespace or default import         (case b)
//   flagGateLocals      : local names bound to `withFlagGate` from a flag-gate module (exemption)
function buildImportMaps(program) {
  const importedMatchLocals = new Set();
  const nsOrDefaultLocals = new Set();
  const flagGateLocals = new Set();

  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const source = typeof stmt.source.value === "string" ? stmt.source.value : "";
    const fromFlagGate = isFlagGateModule(source);

    for (const spec of stmt.specifiers) {
      if (spec.type === "ImportSpecifier") {
        // `import { imported as local }` — the IMPORTED name is what identifies a flag helper.
        const imported = spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value);
        const local = spec.local.name;
        if (FLAG_CALL.test(imported)) importedMatchLocals.add(local);
        if (fromFlagGate && imported === "withFlagGate") flagGateLocals.add(local);
      } else if (spec.type === "ImportDefaultSpecifier") {
        // A default import has no imported identifier; fall back to the binding name for FLAG_CALL,
        // and treat it as a namespace-like root for member access (case b).
        const local = spec.local.name;
        nsOrDefaultLocals.add(local);
        if (FLAG_CALL.test(local)) importedMatchLocals.add(local);
      } else if (spec.type === "ImportNamespaceSpecifier") {
        nsOrDefaultLocals.add(spec.local.name);
      }
    }
  }
  return { importedMatchLocals, nsOrDefaultLocals, flagGateLocals };
}

// Resolve a name through the scope chain (innermost first) to its declaration, honouring shadowing.
function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const v = s.variables.find((x) => x.name === name);
    if (v) return v;
  }
  return null;
}

function isImportBinding(variable) {
  return !!(variable && variable.defs && variable.defs[0] && variable.defs[0].type === "ImportBinding");
}

// `ns.X` or `ns["X"]` (string-literal computed) -> "X"; anything else (template, dynamic) -> null.
function memberPropertyName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

function propKeyName(prop) {
  if (prop.computed) return prop.key.type === "Literal" ? String(prop.key.value) : null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  return null;
}

// Is this CallExpression a hand-written flag check? (Resolution-based, not spelling-based.)
function isFlagCheckCall(node, scope, maps) {
  const callee = node.callee;

  if (callee.type === "Identifier") {
    const variable = findVariable(scope, callee.name);
    if (variable) {
      // (a) callee is an import binding whose imported name matched FLAG_CALL (incl. aliases/defaults).
      if (isImportBinding(variable)) return maps.importedMatchLocals.has(callee.name);
      // Locally declared function/variable/parameter (e.g. `const isSubmitEnabled = ...`): never a flag check.
      return false;
    }
    // (c) bare identifier with no local declaration (global / undeclared) that spells like a flag check.
    return FLAG_CALL.test(callee.name);
  }

  if (callee.type === "MemberExpression") {
    const obj = callee.object;
    if (obj.type !== "Identifier") return false;
    // (b) `ns.X(...)` / `ns["X"](...)` only when `ns` is a namespace or default import.
    const variable = findVariable(scope, obj.name);
    if (!isImportBinding(variable) || !maps.nsOrDefaultLocals.has(obj.name)) return false;
    const prop = memberPropertyName(callee);
    return prop != null && FLAG_CALL.test(prop);
  }

  return false;
}

// Exempt a check ONLY when it runs inside the function value of the `flag` property of the first
// (spec) argument object of a withFlagGate(...) call, and withFlagGate resolves to a flag-gate import.
// Eager args (`withFlagGate(await predicate())`) and local functions named withFlagGate are NOT exempt.
function insideFlagGatePredicate(node, flagGateLocals) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "ArrowFunctionExpression" && parent.type !== "FunctionExpression") continue;
    const prop = parent.parent;
    if (!prop || prop.type !== "Property" || prop.value !== parent || propKeyName(prop) !== "flag") continue;
    const obj = prop.parent;
    if (!obj || obj.type !== "ObjectExpression") continue;
    const call = obj.parent;
    if (
      call &&
      call.type === "CallExpression" &&
      call.arguments[0] === obj &&
      call.callee.type === "Identifier" &&
      flagGateLocals.has(call.callee.name)
    ) {
      return true;
    }
  }
  return false;
}

// Shared visitor: collect every call, then at Program:exit resolve imports+scope and hand the
// offending nodes to a reporting strategy. Lint and counting use IDENTICAL detection this way.
function createRule(report) {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow hand-written feature-flag checks in src/app route/page code; use withFlagGate.",
      },
      schema: [],
      messages: { handwritten: MESSAGE },
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const calls = [];
      return {
        CallExpression(node) {
          calls.push(node);
        },
        "Program:exit"(program) {
          const maps = buildImportMaps(program);
          const offending = calls.filter(
            (node) =>
              isFlagCheckCall(node, sourceCode.getScope(node), maps) &&
              !insideFlagGatePredicate(node, maps.flagGateLocals),
          );
          report(context, offending);
        },
      };
    },
  };
}

// Real rule: ratchet against the per-file allowlist allowance (AST count, same as the test/regen).
const rule = createRule((context, offending) => {
  const filename = context.filename ?? context.getFilename();
  const relPath = path.relative(repoRoot, filename).split(path.sep).join("/");
  const allowance = Object.prototype.hasOwnProperty.call(allowlist, relPath) ? allowlist[relPath] : 0;
  if (offending.length > allowance) {
    for (const node of offending.slice(allowance)) context.report({ node, messageId: "handwritten" });
  }
});

// Counting rule: report EVERY offending call (no allowlist). Used by countFlagChecks below.
const countRule = createRule((context, offending) => {
  for (const node of offending) context.report({ node, messageId: "handwritten" });
});

const plugin = { rules: { "flag-gate": rule, "flag-gate-count": countRule } };

// ---- Pure counting helper: run the SAME AST visitor via Linter and return the call count. ----
// The TypeScript parser is loaded lazily so the ESLint plugin load path stays free of it.
let parserPromise;
async function loadTsParser() {
  if (!parserPromise) {
    parserPromise = import("@typescript-eslint/parser").then((m) => m.default ?? m);
  }
  return parserPromise;
}

export async function countFlagChecks(sourceText, filename) {
  const parser = await loadTsParser();
  const isTsx = typeof filename === "string" && filename.endsWith(".tsx");
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    sourceText,
    {
      files: ["**/*.ts", "**/*.tsx"],
      plugins: { condola: plugin },
      languageOptions: {
        parser,
        ecmaVersion: 2022,
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: isTsx } },
      },
      rules: { "condola/flag-gate-count": "error" },
    },
    { filename: typeof filename === "string" ? filename : "file.ts" },
  );
  const fatal = messages.find((m) => m.fatal);
  if (fatal) {
    throw new Error(`countFlagChecks: parse error in ${filename}: ${fatal.message} (line ${fatal.line ?? "?"})`);
  }
  const unconfigured = messages.find((m) => m.ruleId === null);
  if (unconfigured) throw new Error(`countFlagChecks: ${filename}: ${unconfigured.message}`);
  return messages.filter((m) => m.ruleId === "condola/flag-gate-count").length;
}

export default plugin;
export { rule, plugin };
