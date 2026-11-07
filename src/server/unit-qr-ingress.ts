import { isIP } from "node:net";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export function normalizeUnitQrIp(value?: string | null): string | null {
  const ip = value?.trim();
  if (!ip || ip.includes("%") || !isIP(ip)) return null;
  if (isIP(ip) === 4) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const words = mapped.slice(1).map(word => parseInt(word, 16));
  return words.flatMap(word => [word >> 8, word & 255]).join(".");
}

export function unitQrClientIp(headers: Headers, ingress: { cloudflare: boolean; socketAddress?: string | null }) {
  // Only the Worker runtime establishes header trust; no header can enable it.
  return normalizeUnitQrIp(ingress.cloudflare ? headers.get("cf-connecting-ip") : ingress.socketAddress);
}

export function unitQrIngress() {
  try {
    const { cf } = getCloudflareContext(); // Synchronous: never starts a dev proxy or network request.
    return { cloudflare: Boolean(cf) };
  } catch {
    // Next App Router exposes no socket address. Use the shared unknown limiter
    // bucket instead of accepting any caller-supplied forwarding header.
    return { cloudflare: false };
  }
}
