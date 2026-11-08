const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRequestId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
