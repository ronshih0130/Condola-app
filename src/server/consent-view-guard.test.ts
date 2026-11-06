import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve("src");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const paths = files(root).filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
const program = ts.createProgram(paths, {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
  baseUrl: resolve("."), paths: { "@/*": ["src/*"] },
});
const checker = program.getTypeChecker();
const writers = new Set([
  "writeConsent", "persistConsent", "writeConsentSql", "deliverConsent", "passConsentGate",
  "insertPartnerDocumentsOn", "recordPartnerConsentOn", "insertSignupPartnerConsentOn", "submitPartnerConsent",
  "actionAcceptReconsent", "actionAcceptPortalConsent",
]);
const writeSql = /\b(?:insert\s+into|update)\s+(?:public\s*\.\s*)?(?:consents|partner_agreement_consents)\b/i;

function target(node: ts.Node, typeChecker = checker): ts.Symbol | undefined {
  const symbol = typeChecker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(symbol) : symbol);
}

function hasDirective(node: ts.SourceFile | ts.Block, directive: string): boolean {
  for (const statement of node.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === directive) return true;
  }
  return false;
}

/** Follow invoked functions, referenced values and rendered server components.
 * Imports alone and action/client bodies are not render-time execution. */
function violations(start: ts.Node, typeChecker = checker): string[] {
  const found = new Set<string>();
  const visited = new Set<ts.Node>();
  const valuesVisited = new Set<ts.Node>();
  const followed = new Set<ts.Node>();
  function localDeclarations(node: ts.Node, symbol = target(node, typeChecker)): readonly ts.Declaration[] {
    return (symbol?.declarations ?? []).filter((declaration) => {
      const file = declaration.getSourceFile();
      return file.fileName.startsWith(root + "/") && !file.fileName.includes("node_modules") &&
        !hasDirective(file, "use client") && !hasDirective(file, "use server");
    });
  }
  function propertyName(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isComputedPropertyName(node)) return propertyName(node.expression);
  }
  // Resolve the selected member, not every sibling in the containing object.
  // Syntax preserves array positions even when TypeScript inferred an array rather than a tuple.
  function memberValues(expression: ts.Node, key: string, resolving: Set<ts.Node>): ts.Node[] {
    if (resolving.has(expression) || ts.isSourceFile(expression)) return [];
    const next = new Set(resolving).add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
      return memberValues(expression.expression, key, next);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const element = expression.elements[Number(key)];
      return element && !ts.isOmittedExpression(element) ? [element] : [];
    }
    const property = typeChecker.getPropertyOfType(typeChecker.getTypeAtLocation(expression), key);
    // Namespace imports expose exports through their type, including re-export aliases.
    const resolved = property ? localDeclarations(expression,
      property.flags & ts.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(property) : property) : [];
    return [...resolved, ...valueSources(expression, next).flatMap((value) => memberValues(value, key, next))];
  }
  function declarationValues(declaration: ts.Declaration, resolving: Set<ts.Node>): ts.Node[] {
    if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isParameter(declaration)) {
      return declaration.initializer ? [declaration.initializer] : [];
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return [...localDeclarations(declaration.name, typeChecker.getShorthandAssignmentValueSymbol(declaration))];
    }
    if (ts.isBindingElement(declaration)) {
      if (resolving.has(declaration)) return [];
      const next = new Set(resolving).add(declaration);
      const pattern = declaration.parent;
      const key = ts.isArrayBindingPattern(pattern) ? String(pattern.elements.indexOf(declaration)) :
        propertyName(declaration.propertyName ?? declaration.name);
      const values = declarationValues(pattern.parent, next);
      return [
        ...(declaration.initializer ? [declaration.initializer] : []),
        ...values.flatMap((value) => key === undefined ? [] : memberValues(value, key, next)),
      ];
    }
    if (ts.isExportAssignment(declaration)) return [declaration.expression];
    return [];
  }
  function valueSources(node: ts.Node, resolving = new Set<ts.Node>()): ts.Node[] {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) || ts.isExportAssignment(node)) {
      return declarationValues(node, resolving);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = propertyName(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
      return key === undefined ? [] : memberValues(node.expression, key, resolving);
    }
    return [...localDeclarations(node)];
  }
  function visitValue(node: ts.Node) {
    if (valuesVisited.has(node)) return;
    valuesVisited.add(node);
    // A function value (including one stored in an object) is not an invocation.
    if (ts.isSourceFile(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) return;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) visitValue(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) visitValue(property.name);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(visitValue);
    } else if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) || ts.isExportAssignment(node)) {
      valueSources(node).forEach(visitValue);
    } else {
      visit(node);
    }
  }
  function invoke(expression: ts.Node) {
    if (followed.has(expression)) return;
    followed.add(expression);
    const symbol = target(expression, typeChecker) ??
      ((ts.isFunctionDeclaration(expression) || ts.isMethodDeclaration(expression)) && expression.name ?
        target(expression.name, typeChecker) : undefined);
    const name = symbol?.name ?? (ts.isIdentifier(expression) ? expression.text : "");
    if (writers.has(name)) found.add(name);
    // Function.prototype indirection and chained bind(...)(...) retain the target.
    if (ts.isPropertyAccessExpression(expression) && ["call", "apply", "bind"].includes(expression.name.text)) {
      invoke(expression.expression);
    } else if (ts.isCallExpression(expression) || ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
      invoke(expression.expression);
    } else if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ||
        ts.isFunctionDeclaration(expression) || ts.isMethodDeclaration(expression)) {
      if (expression.body) visit(expression.body);
    }
    for (const value of valueSources(expression)) {
      invoke(value);
      visitValue(value);
    }
  }
  function visit(node: ts.Node) {
    if (visited.has(node)) return;
    visited.add(node);
    if (ts.isSourceFile(node) && (hasDirective(node, "use client") || hasDirective(node, "use server"))) return;
    if (ts.isBlock(node) && hasDirective(node, "use server")) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const sql = ts.isTemplateExpression(node) ? node.getText() : node.text;
      if (writeSql.test(sql.replaceAll('"', ""))) found.add("consent SQL write");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "write" &&
        (target(node.expression, typeChecker)?.name === "consentRepository" || /consent/i.test(node.expression.getText()))) {
      found.add("consent repository write");
    }
    if (ts.isCallExpression(node)) invoke(node.expression);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) invoke(node.tagName);
    // Resolve same-module/imported constants without entering uninvoked functions
    // (e.g. a server action supplied as a form's action prop).
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      valueSources(node).forEach(visitValue);
    }
    if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && node === start) invoke(node);
    ts.forEachChild(node, visit);
  }
  visit(start);
  return [...found].sort();
}

function getHandler(file: ts.SourceFile, typeChecker = checker): ts.Node | undefined {
  const moduleSymbol = typeChecker.getSymbolAtLocation(file);
  const symbol = moduleSymbol && typeChecker.getExportsOfModule(moduleSymbol).find((item) => item.name === "GET");
  if (!symbol) return;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolved.valueDeclaration;
  assert.ok(declaration, file.fileName + ": unclassified GET export");
  return declaration;
}

test("viewing pages, layouts and GET routes never records consent", () => {
  const failures: string[] = [];
  for (const path of paths.filter((path) => path.startsWith(join(root, "app") + "/"))) {
    const file = program.getSourceFile(path)!;
    const entry = /\/(page|layout)\.tsx$/.test(path) ? file : /\/route\.ts$/.test(path) ? getHandler(file) : undefined;
    if (!entry) continue;
    const hits = violations(entry);
    if (hits.length) failures.push(`${relative(root, path)}: ${hits.join(", ")}`);
  }
  assert.deepEqual(failures, []);
});

test("view guard detects SQL writes and explicit writers but permits reads", () => {
  for (const code of [
    'async function GET() { await db.query(`INSERT INTO public.consents (user_id) VALUES ($1)`); }',
    'const GET = () => db.query(`UPDATE "public"."partner_agreement_consents" SET version = $1`);',
    'function Page() { writeConsent(user); }',
    'function Page() { consentRepository.write(user, record); }',
  ]) {
    const file = ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
    assert.ok(violations(file).length, code);
  }
  const file = ts.createSourceFile("fixture.ts", 'function Page() { return db.query(`SELECT * FROM public.consents`); }', ts.ScriptTarget.Latest, true);
  assert.deepEqual(violations(file), []);
});


/** A complete in-memory module graph, with real TypeScript alias resolution. */
function fixtureViolations(sources: Record<string, string>, entry = "route.ts") {
  const base = resolve(root, "__consent_view_fixture");
  const virtual = new Map(Object.entries(sources).map(([path, source]) => [resolve(base, path), source]));
  const options = { ...program.getCompilerOptions(), noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.fileExists = (path) => virtual.has(path);
  host.readFile = (path) => virtual.get(path);
  host.getSourceFile = (path, languageVersion) => {
    const source = virtual.get(path);
    return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true);
  };
  host.resolveModuleNames = (names, containingFile) => names.map((name) => {
    const path = name.startsWith("@/") ? resolve(root, name.slice(2)) : resolve(dirname(containingFile), name);
    const resolvedFileName = [path, path + ".ts", path + ".tsx", join(path, "index.ts")].find((candidate) => virtual.has(candidate));
    return resolvedFileName ? { resolvedFileName } : undefined;
  });
  const fixture = ts.createProgram([...virtual.keys()], options, host);
  const fixtureChecker = fixture.getTypeChecker();
  const file = fixture.getSourceFile(resolve(base, entry))!;
  const start = entry === "route.ts" ? getHandler(file, fixtureChecker) : file;
  assert.ok(start);
  return violations(start, fixtureChecker);
}
const fixtureWriters = `export function writeConsent() {}
  export const consentRepository = { write() {} };`;

for (const invocation of [
  "writeConsent()", "writeConsent.call(null)", "writeConsent.apply(null, [])",
  "writeConsent.bind(null)()", "const accept = writeConsent; accept()",
  "const first = writeConsent; const accept = first; accept()",
  "const accept = writeConsent.bind(null); accept()",
  "const accept = consentRepository.write; accept()",
]) {
  test(`view guard detects indirect writer: ${invocation}`, () => {
    assert.ok(fixtureViolations({
      "writers.ts": fixtureWriters,
      "route.ts": `import { writeConsent, consentRepository } from "./writers";
        export function GET() { ${invocation}; }`,
    }).length);
  });
}

test("view guard follows imported aliases and a bare GET wrapper reference", () => {
  assert.ok(fixtureViolations({
    "writers.ts": fixtureWriters,
    "route.ts": `import { writeConsent as accept } from "./writers";
      function wrapper() { accept(); } export const GET = wrapper;`,
  }).length);
});

for (const handler of [
  "export const { handle: GET } = { handle: wrapper };",
  "export const [GET] = [wrapper];",
]) {
  test(`view guard invokes destructured GET exports: ${handler}`, () => {
    assert.ok(fixtureViolations({
      "writers.ts": fixtureWriters,
      "route.ts": `import { writeConsent } from "./writers";
        function wrapper() { writeConsent(); } ${handler}`,
    }).includes("writeConsent"));
  });
}

for (const [setup, invocation] of [
  ["", "consent.writeConsent()"],
  ["const { writeConsent } = consent;", "writeConsent()"],
  ["const { writeConsent: accept } = consent;", "accept()"],
  ["const { writeConsent: accept = () => {} } = consent;", "accept()"],
  ["const { go: accept = consent.writeConsent } = {};", "accept()"],
  ["const { nested: { writeConsent: accept } } = { nested: consent };", "accept()"],
  ["const [accept] = [consent.writeConsent];", "accept()"],
  ["const [, accept] = [() => {}, consent.writeConsent];", "accept()"],
  ["const [accept = consent.writeConsent] = [];", "accept()"],
  ["const [{ go: accept }] = [{ go: consent.writeConsent }];", "accept()"],
  ["const w = { go: writeConsent };", "w.go()"],
  ["const w = { writeConsent };", "w.writeConsent()"],
  ["const w = { go: writeConsent }; const accept = w.go;", "accept()"],
  ["const w = { go: writeConsent }; const { go: accept } = w;", "accept()"],
  ["const w = { go: writeConsent };", 'w["go"]()'],
]) {
  test(`view guard resolves writer binding: ${setup} ${invocation}`, () => {
    for (const local of [false, true]) {
      assert.ok(fixtureViolations({
        "writers.ts": fixtureWriters,
        "route.ts": `import * as consent from "@/__consent_view_fixture/writers";
          import { writeConsent } from "./writers";
          ${local ? "" : setup} export function GET() { ${local ? setup : ""} ${invocation}; }`,
      }).includes("writeConsent"), local ? "GET-local binding" : "module binding");
    }
  });
}

for (const [setup, value] of [
  ["", "sql.mutation"],
  ["const { mutation } = sql;", "mutation"],
  ["const { mutation: statement } = sql;", "statement"],
  ["const { mutation: statement = 'SELECT 1' } = sql;", "statement"],
  ["const { missing: statement = sql.mutation } = {};", "statement"],
  ["const [statement] = [sql.mutation];", "statement"],
  ["const [, statement = sql.mutation] = [];", "statement"],
  ["const { nested: [statement] } = { nested: [sql.mutation] };", "statement"],
  ["const statements = { write: sql.mutation };", "statements.write"],
  ["const statements = { write: sql.mutation }; const { write: statement } = statements;", "statement"],
]) {
  test(`view guard resolves SQL binding: ${setup} ${value}`, () => {
    for (const local of [false, true]) {
      assert.ok(fixtureViolations({
        "sql.ts": 'export const statement = "INSERT INTO consents DEFAULT VALUES";',
        "barrel.ts": 'export { statement as mutation } from "./sql";',
        "route.ts": `import * as sql from "./barrel";
          ${local ? "" : setup} export function GET() { ${local ? setup : ""} return db.query(${value}); }`,
      }).includes("consent SQL write"), local ? "GET-local binding" : "module binding");
    }
  });
}

for (const [setup, component] of [
  ["const { Nested: Child } = Components;", "Child"],
  ["const { Nested: Child = () => null } = Components;", "Child"],
  ["const { missing: Child = Components.Nested } = {};", "Child"],
  ["const [Child] = [Components.Nested];", "Child"],
  ["const [Child = Components.Nested] = [];", "Child"],
  ["const { nested: [Child] } = { nested: [Components.Nested] };", "Child"],
  ["const views = { Child: Components.Nested };", "views.Child"],
  ["const views = { Child: Components.Nested }; const { Child } = views;", "Child"],
]) {
  test(`view guard resolves transitive server component binding: ${setup}`, () => {
    for (const local of [false, true]) {
      assert.ok(fixtureViolations({
        "writers.ts": fixtureWriters,
        "leaf.tsx": `import { writeConsent } from "./writers";
          export function Leaf() { writeConsent(); return <div />; }`,
        "barrel.ts": 'export { Leaf as Nested } from "./leaf";',
        "shell.tsx": `import * as Components from "./barrel"; ${local ? "" : setup}
          export default function Shell() { ${local ? setup : ""} return <${component} />; }`,
        "page.tsx": 'import Shell from "./shell"; export default function Page() { return <Shell />; }',
      }, "page.tsx").includes("writeConsent"), local ? "component-local binding" : "module binding");
    }
  });
}

for (const sql of ["INSERT INTO public.consents DEFAULT VALUES", 'UPDATE "public"."partner_agreement_consents" SET version = $1']) {
  for (const imported of [false, true]) {
    test(`view guard detects ${imported ? "imported" : "module-level"} SQL: ${sql}`, () => {
      assert.ok(fixtureViolations({
        "sql.ts": `export const statement = ${JSON.stringify(sql)};`,
        "barrel.ts": 'export { statement as mutation } from "./sql";',
        "route.ts": `${imported ? 'import { mutation } from "./barrel";' : `const mutation = ${JSON.stringify(sql)};`}
          const alias = mutation; export function GET() { return db.query(alias); }`,
      }).includes("consent SQL write"));
    });
  }
}

for (const entry of ["page.tsx", "layout.tsx"]) {
  for (const body of ["writeConsent.call(null);", "db.query(statement);"]) {
    test(`view guard follows transitive server components from ${entry}: ${body}`, () => {
      assert.ok(fixtureViolations({
        "writers.ts": fixtureWriters,
        "sql.ts": 'export const statement = "INSERT INTO partner_agreement_consents DEFAULT VALUES";',
        "leaf.tsx": `import { writeConsent } from "./writers"; import { statement } from "./sql";
          export const Leaf = () => { ${body} return <div />; };`,
        "barrel.ts": 'export { Leaf as Nested } from "./leaf";',
        "shell.tsx": 'import * as Components from "./barrel"; export default function Shell() { return <Components.Nested />; }',
        [entry]: 'import Shell from "@/__consent_view_fixture/shell"; export default function View() { return <Shell />; }',
      }, entry).length);
    });
  }
}

test("view guard allows POST writes while GET only reads", () => {
  assert.deepEqual(fixtureViolations({
    "writers.ts": fixtureWriters,
    "route.ts": `import { writeConsent } from "./writers";
      const mutation = "INSERT INTO consents DEFAULT VALUES";
      export function POST() { writeConsent(); return db.query(mutation); }
      export function GET() { return db.query("SELECT * FROM consents"); }`,
  }), []);
});

test("view guard stops at client components and server actions, including transitive boundaries", () => {
  assert.deepEqual(fixtureViolations({
    "writers.ts": fixtureWriters,
    "actions.ts": `"use server"; import { writeConsent } from "./writers";
      export async function accept() { writeConsent(); db.query("INSERT INTO consents DEFAULT VALUES"); }`,
    "client.tsx": `"use client"; import { accept } from "./actions";
      import { writeConsent } from "./writers";
      export default function Client() { const submit = () => { writeConsent(); accept(); };
        return <button onClick={submit}>Accept</button>; }`,
    "shell.tsx": `import Client from "./client"; import { accept } from "./actions";
      export default function Shell() { return <form action={accept}><Client /></form>; }`,
    "page.tsx": `import Shell from "./shell";
      export default function Page() { return <Shell />; }`,
  }, "page.tsx"), []);
});

test("view guard preserves action and client boundaries through destructuring and property aliases", () => {
  assert.deepEqual(fixtureViolations({
    "writers.ts": fixtureWriters,
    "actions.ts": `"use server"; import { writeConsent } from "./writers";
      export async function accept() { writeConsent(); db.query("INSERT INTO consents DEFAULT VALUES"); }`,
    "client.tsx": `"use client"; import { writeConsent } from "./writers";
      export function Client() { writeConsent(); return <button />; }`,
    "shell.tsx": `import * as actions from "./actions"; import * as client from "./client";
      const { accept: submit } = actions;
      const [accept = submit] = [submit];
      const handlers = { accept };
      const { Client: Child } = client;
      const views = { Child };
      export default function Shell() { return <form action={handlers.accept}><views.Child /></form>; }`,
    "page.tsx": 'import Shell from "./shell"; export default function Page() { return <Shell />; }',
  }, "page.tsx"), []);
});

test("view guard permits destructured POST writers and SQL when GET only reads", () => {
  assert.deepEqual(fixtureViolations({
    "writers.ts": fixtureWriters,
    "sql.ts": 'export const mutation = "INSERT INTO consents DEFAULT VALUES";',
    "route.ts": `import * as consent from "./writers"; import * as sql from "./sql";
      const { writeConsent: accept } = consent;
      const [statement] = [sql.mutation];
      const handlers = { accept };
      export function POST() { handlers.accept(); return db.query(statement); }
      export function GET() { return db.query("SELECT * FROM consents"); }`,
  }), []);
});

test("view guard does not execute unused functions in a selected component's namespace", () => {
  assert.deepEqual(fixtureViolations({
    "writers.ts": fixtureWriters,
    "components.tsx": `import { writeConsent } from "./writers";
      export function Unused() { writeConsent(); return <div />; }
      export function ReadOnly() { return <div />; }`,
    "shell.tsx": `import * as components from "./components";
      const { ReadOnly: Child } = components;
      const views = { Child };
      export default function Shell() { return <views.Child />; }`,
    "page.tsx": 'import Shell from "./shell"; export default function Page() { return <Shell />; }',
  }, "page.tsx"), []);
});

test("view guard permits inline server action bodies", () => {
  assert.deepEqual(fixtureViolations({
    "writers.ts": fixtureWriters,
    "page.tsx": `import { writeConsent } from "./writers";
      export default function Page() {
        async function accept() { "use server"; writeConsent(); }
        return <form action={accept} />;
      }`,
  }, "page.tsx"), []);
});
