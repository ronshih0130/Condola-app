import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const preflight = path.join(repo, 'scripts', 'preflight-deploy.sh');
const recordBuildNode = path.join(repo, 'scripts', 'record-build-node.mjs');

function runPreflight(t, pin, version, stamp) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-node-major-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const worktree = fs.realpathSync(temp);

    if (pin !== null) {
        fs.writeFileSync(path.join(worktree, '.nvmrc'), pin);
    }

    if (stamp !== undefined) {
        const openNext = path.join(worktree, '.open-next');
        fs.mkdirSync(openNext);
        fs.writeFileSync(path.join(openNext, 'build-node-version.txt'), stamp);
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

test('preflight rejects a build Node major that differs from the pin', (t) => {
    const { stdout } = runPreflight(t, '22.23.5\n', '22.23.5', 'v20.20.2\n');
    assert.ok(stdout.includes('PREFLIGHT FAIL: build node major 20 does not match pinned major 22 from .nvmrc (stamp: v20.20.2)'));
});

test('preflight reports a missing build Node stamp', (t) => {
    const { stdout } = runPreflight(t, '22.23.5\n', '22.23.5');
    assert.ok(stdout.includes('PREFLIGHT FAIL: build node stamp missing or unreadable'));
});

test('preflight prints the build Node version when both majors match the pin', (t) => {
    const { stdout } = runPreflight(t, '22.23.5\n', '22.23.5', 'v22.23.5\n');
    assert.ok(stdout.split('\n').includes('build node: v22.23.5'));
    assert.doesNotMatch(stdout, /^PREFLIGHT FAIL: (build )?node /m);
});

test('record-build-node writes the Node version into an existing .open-next directory', (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-build-node-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const openNext = path.join(temp, '.open-next');
    fs.mkdirSync(openNext);

    const result = spawnSync(process.execPath, [recordBuildNode], { cwd: temp });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(path.join(openNext, 'build-node-version.txt'), 'utf8'), process.version + '\n');
});

test('record-build-node fails without creating a missing .open-next directory', (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-build-node-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const openNext = path.join(temp, '.open-next');

    const result = spawnSync(process.execPath, [recordBuildNode], { cwd: temp });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(openNext, 'build-node-version.txt')), false);
    assert.equal(fs.existsSync(openNext), false);
});
