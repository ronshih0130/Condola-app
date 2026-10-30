/** Isolated, non-durable reference model for tests only. Never use as a sender. */
import { resendEligibility, settleResend, simulatedResult, type ResendResult, type TrustedResendSnapshot } from "../lib/portal-resend-state";

type Outcome = "captured" | "accepted" | "rejected";
type Request = Readonly<{ requestId: string; sourceId: string; orgId: string; actorId: string; generation: number; payloadDigest: string; snapshot: TrustedResendSnapshot }>;
type Script = (signal: AbortSignal) => Promise<Outcome>;
type Clock = { schedule: (callback: () => void) => () => void };
type Entry = { fingerprint: string; result: ResendResult; promise: Promise<ResendResult> };
export function createResendMemory(script: Script, clock: Clock) {
  const requests = new Map<string, Entry>();
  const active = new Set<string>();
  return {
    run(input: Request): Promise<ResendResult> {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (![input.requestId, input.sourceId, input.orgId, input.actorId].every(id => typeof id === "string" && uuid.test(id)) || !/^[0-9a-f]{64}$/.test(input.payloadDigest) || !Number.isSafeInteger(input.generation) || input.generation < 0) return Promise.resolve(simulatedResult("conflict"));
      const org = input.orgId.toLowerCase(), actor = input.actorId.toLowerCase(), source = input.sourceId.toLowerCase();
      const requestKey = JSON.stringify([org, actor, input.requestId.toLowerCase()]);
      const fingerprint = JSON.stringify([source, input.generation, input.payloadDigest]);
      const previous = requests.get(requestKey);
      if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.resolve(simulatedResult("conflict"));
      const eligibility = resendEligibility(input.snapshot);
      if (eligibility) return Promise.resolve(eligibility);
      const key = JSON.stringify([org, source]);
      if (active.has(key)) return Promise.resolve(simulatedResult("conflict"));
      active.add(key);
      const controller = new AbortController();
      const entry: Entry = { fingerprint, result: simulatedResult("processing"), promise: Promise.resolve(simulatedResult("processing")) };
      requests.set(requestKey, entry);
      entry.promise = new Promise<ResendResult>((resolve) => {
        let terminal = false;
        let cancel = () => {};
        const finish = (outcome: Outcome | "unknown") => {
          if (terminal) return;
          terminal = true; cancel(); controller.abort();
          entry.result = settleResend(entry.result, outcome); if (outcome === "rejected") active.delete(key); resolve(entry.result);
        };
        cancel = clock.schedule(() => finish("unknown"));
        Promise.resolve().then(() => terminal ? undefined : script(controller.signal)).then(value => { if (!terminal) finish(value === "captured" || value === "accepted" || value === "rejected" ? value : "unknown"); }, () => finish("unknown"));
      });
      return entry.promise;
    },
  };
}
