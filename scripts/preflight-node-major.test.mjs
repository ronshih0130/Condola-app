import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const preflight = path.join(repo, 'scripts', 'preflight-deploy.sh');

function runPreflight(t, pin, version) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-node-major-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const worktree = fs.realpathSync(temp);

    if (pin !== null) {
        fs.writeFileSync(path.join(worktree, '.nvmrc'), pin);
    }

    const bin = fs.mkdtempSync(path.join(worktree, 'bin-'));
    const node = path.join(bin, 'node');
    fs.writeFileSync(node, `#!/bin/sh\necho v${version}\n`);
    fs.chmodSync(node, 0o755);

    const result = spawnSync('bash', [preflight, worktree], {
        cwd: worktree,
        env: {
            ...process.env,
            PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
        },
        encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
}

test('preflight rejects a running Node major that differs from the pin', (t) => {
    const { stdout, status } = runPreflight(t, '20.20.2\n', '22.23.5');
    assert.match(stdout, /PREFLIGHT FAIL: node major 22 does not match pinned major 20 from \.nvmrc/);
    assert.notEqual(status, 0);
    assert.doesNotMatch(stdout, /PREFLIGHT PASS/);
});

test('preflight reports no Node failure when the major matches', (t) => {
    const { stdout } = runPreflight(t, '20.20.2\n', '20.20.2');
    assert.doesNotMatch(stdout, /^PREFLIGHT FAIL: node (major|pin|not found|cannot parse)/m);
});

test('preflight reads the pinned major from the target worktree', (t) => {
    const { stdout } = runPreflight(t, 'v18\n', '20.1.0');
    assert.match(stdout, /PREFLIGHT FAIL: node major 20 does not match pinned major 18 from \.nvmrc/);
});

test('preflight reports a missing Node pin', (t) => {
    const { stdout } = runPreflight(t, null, '20.20.2');
    assert.match(stdout, /PREFLIGHT FAIL: node pin unreadable/);
});
