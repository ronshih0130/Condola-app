/** R2-PROP / MGT-82 AC2,7–9. null is unknown, never a completed item. */
export type PropertyTask = "roomType" | "tenant" | "address" | "owner" | "money" | "lease";
export type PropertyRoomFacts = {
  id: string; unitId: string; kind: "room" | "whole_unit"; label: string; unitLabel: string;
  roomType: string | null; addressReady: boolean; ownerReady: boolean;
  moneyReady: boolean | null; tenantReady: boolean | null;
  leaseStatus: "active" | "pending_signature" | "draft" | null;
};
export function propertyRoomState(facts: PropertyRoomFacts) {
  const tasks: { key: PropertyTask; ready: boolean | null }[] = [
    ...(facts.kind === "room" ? [{key:"roomType" as const,ready:!!facts.roomType && facts.roomType!=="unspecified"}] : []),
    {key:"tenant",ready:facts.tenantReady}, {key:"address",ready:facts.addressReady},
    {key:"owner",ready:facts.ownerReady}, {key:"money",ready:facts.moneyReady},
    {key:"lease",ready:facts.leaseStatus!==null},
  ];
  const pending = tasks.filter(t=>t.ready===false).map(t=>t.key);
  const unknown = tasks.filter(t=>t.ready===null).map(t=>t.key);
  return {...facts,tasks,pending,unknown,
    occupied:facts.leaseStatus==="active" || facts.leaseStatus==="pending_signature",
    status:facts.leaseStatus ?? ("vacant" as const)};
}
export type PropertyRoom = ReturnType<typeof propertyRoomState>;
export function propertyTotals(rows: PropertyRoom[]) {
  return { rooms:rows.length,occupied:rows.filter(r=>r.occupied).length,
    pending:rows.reduce((n,r)=>n+r.pending.length,0),unknown:rows.reduce((n,r)=>n+r.unknown.length,0) };
}
