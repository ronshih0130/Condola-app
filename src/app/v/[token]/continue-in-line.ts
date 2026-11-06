/**
 * B-035 job entry: same-origin POST bodies only. The raw job token never enters a URL, Referer, history,
 * storage or log; only the opaque B-033 flow handle reaches the existing /v/liff bootstrap URL.
 */
export type ContinueInLineDeps = {
  fetch: (path: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
  navigate: (path: string) => void;
};

const LIFF_URL = /^\/v\/liff\?flow=[\w-]{43}$/;

export async function continueInLine(jobToken: string, deps: ContinueInLineDeps): Promise<boolean> {
  const post = async (path: string, value: Record<string, string>) => {
    const response = await deps.fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error("line_unavailable");
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    const proof = await post("/v/liff", { jobToken });
    if (typeof proof.csrf !== "string") return false;
    const flow = await post("/api/line/flows", { purpose: "login", persona: "vendor", jobToken, csrf: proof.csrf });
    if (typeof flow.liffUrl !== "string" || !LIFF_URL.test(flow.liffUrl)) return false;
    deps.navigate(flow.liffUrl);
    return true;
  } catch {
    return false;
  }
}
