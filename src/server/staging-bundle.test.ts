import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("the staging tarball contains the scheduled worker entry and the OpenNext worker it imports", () => {
  const root = mkdtempSync(path.join(tmpdir(), "condola-bundle-"));
  try {
    mkdirSync(path.join(root, ".open-next"));
    writeFileSync(path.join(root, "custom-worker.mjs"), readFileSync("custom-worker.mjs"));
    writeFileSync(path.join(root, "id-purge-cron.mjs"), readFileSync("id-purge-cron.mjs"));
    writeFileSync(
      path.join(root, ".open-next/worker.js"),
      "export default { fetch() { return new Response('ok'); } };\n",
    );
    writeFileSync(path.join(root, "wrangler.jsonc"), readFileSync("wrangler.jsonc"));
    writeFileSync(path.join(root, "package.json"), readFileSync("package.json"));
    writeFileSync(path.join(root, "COMMIT"), "abc\nsubject\n");
    const out = path.join(root, "bundle.tar.gz");
    execFileSync("bash", ["scripts/pack-staging-bundle.sh", out], {
      env: { ...process.env, SOURCE_ROOT: root },
      encoding: "utf8",
    });
    const names = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
    assert.match(names, /^\.\/custom-worker\.mjs$/m);
    assert.match(names, /^\.\/id-purge-cron\.mjs$/m);
    assert.match(names, /^\.\/\.open-next\/worker\.js$/m);
    const entry = execFileSync("tar", ["-xOf", out, "./custom-worker.mjs"], { encoding: "utf8" });
    assert.match(entry, /scheduled\(/);
    assert.match(entry, /purge_due_identity_documents/);
    assert.match(entry, /SET LOCAL ROLE service_role/);
    assert.doesNotMatch(entry, /SET LOCAL ROLE anon/);
    assert.match(entry, /\/api\/cron\/reminders/);
    assert.match(entry, /id-purge failed/);
    assert.match(entry, /import \{ default as handler \} from "\.\/\.open-next\/worker\.js"/);
    const built = execFileSync("tar", ["-xOf", out, "./.open-next/worker.js"], { encoding: "utf8" });
    assert.match(built, /export default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
