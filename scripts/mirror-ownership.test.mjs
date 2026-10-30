import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('mirror ownership accepts only the fresh exact host and supervising session', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'condola-mirror-owner-'));
  const file = path.join(dir, 'status');
  const session = '3099AC86-6AF0-4681-9944-304E930BFDC2';
  const good = `[repo] effective=ACTIVE observed_at=2026-10-29T19:00:00-0700 PT (America/Los_Angeles)\nresource=repo\nstate=ACTIVE\nhost=owned-host\nsession_uuid=${session}\n`;
  const check = (text, host = 'owned-host', id = session) => {
    writeFileSync(file, text);
    try { execFileSync('python3', ['scripts/check-mirror-ownership.py', file, host, id], {stdio:'pipe'}); return true; }
    catch { return false; }
  };
  try {
    assert.equal(check(good), true);
    for (const text of [
      good.replace('effective=ACTIVE','effective=SUSPECT'),
      good.replace('state=ACTIVE','state=RELEASED'),
      good.replace('resource=repo','resource=staging'),
      good.replace('host=owned-host','host=other-host'),
      good + 'state=ACTIVE\n',
      good + '[prod] effective=ACTIVE\nresource=prod\n',
      good.replace(/^.*\n/,''),
      'resource=repo state=ACTIVE host=owned-host\n',
    ]) assert.equal(check(text), false);
    assert.equal(check(good, 'other-host'), false);
    assert.equal(check(good, 'owned-host', session.replace('3099','4099')), false);
    assert.equal(check(good, 'owned-host', ''), false);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
