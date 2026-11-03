/** Pure mock-only rules. The caller must supply freshly verified account state. */
export function normalizeStaffEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return null;
  const local = trimmed.slice(0, at).replaceAll(/\s+/g, '+');
  const domain = trimmed.slice(at + 1).trim();
  const email = `${local}@${domain}`;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Case-fold only; stored and provider addresses are never repaired. */
export function canonicalStaffEmail(value: unknown): string | null {
  return typeof value === 'string' && /^[^\s\x00-\x1f\x7f-\x9f@]+@[^\s\x00-\x1f\x7f-\x9f@]+\.[^\s\x00-\x1f\x7f-\x9f@]+$/.test(value) ? value.toLowerCase() : null;
}

export type BeginRule = 'invalid' | 'excluded' | 'unchanged' | 'pending' | 'ready';
export function assessStaffEmail(input: { current: string; target: string; privileged: readonly string[]; pending: string | null; pendingUnexpired: boolean }): BeginRule {
  const current = canonicalStaffEmail(input.current), target = normalizeStaffEmail(input.target);
  const pending = input.pending === null ? null : canonicalStaffEmail(input.pending);
  const excluded = input.privileged.map(canonicalStaffEmail);
  if (!current || !target || canonicalStaffEmail(target) !== target || (input.pending !== null && !pending) || (input.pendingUnexpired && !pending) || excluded.some((v) => v === null)) return 'invalid';
  if (excluded.includes(current) || excluded.includes(target)) return 'excluded';
  if (current === target) return 'unchanged';
  if (input.pendingUnexpired) return pending === target ? 'pending' : 'invalid';
  return 'ready';
}
