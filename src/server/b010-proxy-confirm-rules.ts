export type Collector = "management" | "owner";

export type ConfirmActor =
  | {
      kind: "staff";
      role: "admin" | "manager" | "accountant" | "maintenance" | null;
      userId: string;
    }
  | {
      kind: "owner";
      userId: string;
      ownerContactId: string | null;
    }
  | {
      kind: "tenant";
      userId: string;
    };

export type ConfirmDecision =
  | {
      ok: true;
      confirmedVia: "management" | "owner_direct" | "staff_proxy";
      onBehalfOfOwnerContactId: string | null;
    }
  | {
      ok: false;
      code:
        | "forbidden"
        | "proxy_confirmation_required"
        | "already_confirmed"
        | "not_submitted";
    };

export function decideConfirmation(input: {
  collector: Collector;
  ownerContactId: string | null;
  actor: ConfirmActor;
  proxyOwnerConfirmed: boolean;
  paymentStatus: string;
}): ConfirmDecision {
  if (input.paymentStatus === "confirmed") {
    return { ok: false, code: "already_confirmed" };
  }

  if (input.paymentStatus !== "submitted") {
    return { ok: false, code: "not_submitted" };
  }

  const { actor } = input;

  if (actor.kind === "tenant") {
    return { ok: false, code: "forbidden" };
  }

  if (
    actor.kind === "staff" &&
    actor.role !== "admin" &&
    actor.role !== "manager" &&
    actor.role !== "accountant"
  ) {
    return { ok: false, code: "forbidden" };
  }

  if (input.collector === "management") {
    if (actor.kind !== "staff") {
      return { ok: false, code: "forbidden" };
    }

    return {
      ok: true,
      confirmedVia: "management",
      onBehalfOfOwnerContactId: null,
    };
  }

  if (actor.kind === "owner") {
    if (actor.ownerContactId !== input.ownerContactId) {
      return { ok: false, code: "forbidden" };
    }

    return {
      ok: true,
      confirmedVia: "owner_direct",
      onBehalfOfOwnerContactId: null,
    };
  }

  if (input.proxyOwnerConfirmed !== true) {
    return { ok: false, code: "proxy_confirmation_required" };
  }

  return {
    ok: true,
    confirmedVia: "staff_proxy",
    onBehalfOfOwnerContactId: input.ownerContactId,
  };
}

export function needsProxyPopup(
  collector: Collector,
  actor: ConfirmActor,
): boolean {
  return collector === "owner" && actor.kind === "staff";
}

export const PROXY_CONFIRM_LABEL = "代屋主確認已繳款";

export function readProxyOwnerConfirmed(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "on";
}
