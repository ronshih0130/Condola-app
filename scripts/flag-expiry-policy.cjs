// B-027 (CAP-P-07/16): canonical flag-registry expiry policy, shared by scripts/gate.sh
// and its unit test. ok | warn (expires within WARN_DAYS — the seven-day reminder) |
// fail (expired, or 14 days after stable GA, or malformed).
"use strict";
const WARN_DAYS = 7;
const DAY = 86400000;

function ptTime(value, label) {
  if (typeof value !== "string") throw new Error(`${label}: quoted PT timestamp required`);
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2}) PT \(America\/Los_Angeles\)$/);
  if (!m) throw new Error(`${label}: explicit offset and PT (America/Los_Angeles) required`);
  const epoch = Date.parse(m[1] + "T" + m[2] + m[3]);
  if (!Number.isFinite(epoch)) throw new Error(`${label}: invalid timestamp`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` !== m[1] + "T" + m[2]) throw new Error(`${label}: date or Los Angeles offset is wrong`);
  return epoch;
}

/** Evaluate parsed flags.yaml entries ([name, flag]) at `now` (ms). Returns { failures, warnings }. */
function evaluateFlags(entries, now) {
  const failures = [], warnings = [], names = new Set();
  for (const [name, flag] of entries) {
    try {
      if (typeof name !== "string" || !name.trim() || names.has(name)) throw new Error("Flag names must be nonempty and unique");
      names.add(name);
      if (!flag || typeof flag !== "object" || Array.isArray(flag) || typeof flag.owner !== "string" || !flag.owner.trim()) throw new Error(`${name}: owner required`);
      if (flag.expires_at !== undefined && flag.expires !== undefined) throw new Error(`${name}: use only one expiry field`);
      const expires = ptTime(flag.expires_at ?? flag.expires, `${name} expiry`);
      if (expires <= now) throw new Error(`${name}: expired`);
      if (expires - now <= WARN_DAYS * DAY) warnings.push(`${name}: expires within ${WARN_DAYS} days (${flag.expires_at ?? flag.expires}); renew with owner approval or remove`);
      if (flag.stable_ga_at !== undefined) {
        const ga = ptTime(flag.stable_ga_at, `${name} stable GA`);
        if (ga > now) throw new Error(`${name}: stable GA cannot be in the future`);
        if (now >= ga + 14 * DAY) throw new Error(`${name}: remove flag after 14 days of stable GA`);
      }
    } catch (error) { failures.push(error.message); }
  }
  return { failures, warnings };
}

module.exports = { WARN_DAYS, ptTime, evaluateFlags };
