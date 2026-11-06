export type SourceRefKind = "lease_charge" | "repair_cost_item" | "deposit_settlement" | "manual" | "other";

export type PeriodDueComponentLine = { componentKey: string; amountMinor: string; currency: string; sourceRefKind: SourceRefKind; sourceRefId?: string | null; note?: string | null };

export type AdvanceCredit = { creditId: string; amountMinor: string; currency: string; status: "approved" | "clawback" | "carry"; sourceExpenseId?: string | null; note?: string | null };

export type MonthlyBillPreviewDTO = { orgId: string; leaseId: string; periodYm: string; currency: string; components: PeriodDueComponentLine[]; advanceCredits: AdvanceCredit[]; grossMinor: string; creditOffsetMinor: string; netMinor: string; carryMinor: string; planVersion: string; planDigest: string };

export type IssuanceResult = { status: "created" | "already_issued" | "replay" | "rejected_disabled" | "rejected_conflict" | "rejected_invalid" | "unsupported"; occurrenceId?: string; invoiceId?: string; requestId?: string; planDigest?: string; amountMinor?: string; replay?: boolean };
