/** Only captured, local transport exists in Slice 1. Never performs HTTP. */
export type LineMessage = { type: "text"; text: string };
export type PushRequest = { channelId: string; to: string; messages: readonly LineMessage[]; headers: { "X-Line-Retry-Key": string } };
export type PushOutcome = { status: "accepted" | "duplicateAccepted" | "failed" | "timeout" };
export interface LineTransport {
  push(req: PushRequest): Promise<PushOutcome>;
  reply(replyToken: string, messages: readonly LineMessage[]): Promise<{ status: "accepted" | "failed" | "timeout" }>;
}
export function createCapturedLineTransport({ mode }: { mode: PushOutcome["status"] }) {
  const calls: ({ method: "push"; request: PushRequest } | { method: "reply"; replyToken: string; messages: readonly LineMessage[] })[] = [];
  const usedTokens = new Set<string>();
  return {
    calls,
    async push(request: PushRequest): Promise<PushOutcome> {
      calls.push({ method: "push", request: structuredClone(request) });
      return { status: mode };
    },
    async reply(replyToken: string, messages: readonly LineMessage[]) {
      calls.push({ method: "reply", replyToken, messages: structuredClone(messages) });
      if (!replyToken || usedTokens.has(replyToken) || mode === "failed") return { status: "failed" as const };
      usedTokens.add(replyToken);
      return { status: mode === "timeout" ? "timeout" as const : "accepted" as const };
    },
  } satisfies LineTransport & { calls: typeof calls };
}
