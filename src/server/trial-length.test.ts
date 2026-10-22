import assert from "node:assert/strict";
import test from "node:test";
import { parseTrialLength, readTrialLength, trialLabel, trialOffer, type TrialLength } from "./trial-length";

test("trial length is supplied by the caller and free plans stay at zero", () => {
  const lengths: TrialLength[] = [
    { unit: "calendar-months", count: 2 },
    { unit: "days", count: 4 },
  ];
  for (const length of lengths) {
    assert.deepEqual(trialOffer("free", length), { unit: "none", count: 0 });
    assert.equal(trialOffer("std", length), length);
    assert.equal(trialOffer("pro", length), length);
    assert.match(trialLabel(length), new RegExp(String(length.count)));
  }
});

test("a missing trial parameter is rejected", () => {
  assert.throws(() => parseTrialLength(undefined, undefined), /QA_TRIAL_UNIT/);
  assert.throws(() => parseTrialLength("calendar-months", undefined), /QA_TRIAL_COUNT/);
  assert.throws(() => parseTrialLength("weeks", "2"), /QA_TRIAL_UNIT/);
  const previousUnit = process.env.QA_TRIAL_UNIT;
  const previousCount = process.env.QA_TRIAL_COUNT;
  try {
    delete process.env.QA_TRIAL_UNIT;
    delete process.env.QA_TRIAL_COUNT;
    assert.throws(() => readTrialLength(), /QA_TRIAL_UNIT/);
  } finally {
    if (previousUnit === undefined) delete process.env.QA_TRIAL_UNIT;
    else process.env.QA_TRIAL_UNIT = previousUnit;
    if (previousCount === undefined) delete process.env.QA_TRIAL_COUNT;
    else process.env.QA_TRIAL_COUNT = previousCount;
  }
});
