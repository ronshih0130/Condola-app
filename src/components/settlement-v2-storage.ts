/** Browser-local command metadata; never a source of authorization. */
export type V2Scope={actorId:string;orgId:string;liveOrgId:string;environment:"live"|"sandbox";leaseId:string};
export type V2Pending={version:1;scope:V2Scope;requestId:string;fingerprint:string;expectedVersion:string|null;digest:string};
type Store=Pick<Storage,"length"|"key"|"getItem"|"setItem"|"removeItem">;
const prefix="condola:settlement-v2:",uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,hex=/^[0-9a-f]{64}$/;
function id(value:unknown):value is string{return typeof value==="string"&&uuid.test(value);}
function validScope(scope:V2Scope){return id(scope.actorId)&&id(scope.orgId)&&id(scope.liveOrgId)&&id(scope.leaseId)&&(scope.environment==="live"||scope.environment==="sandbox");}
function sameScope(a:V2Scope,b:V2Scope){return a.actorId===b.actorId&&a.orgId===b.orgId&&a.liveOrgId===b.liveOrgId&&a.environment===b.environment&&a.leaseId===b.leaseId;}
function key(record:V2Pending){const s=record.scope;return `${prefix}${s.actorId}:${s.orgId}:${s.liveOrgId}:${s.environment}:${s.leaseId}:statement:${record.requestId}`;}
function parse(raw:string):V2Pending {
 if(raw.length>2048)throw new Error("Unavailable");const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Unavailable");const obj=value as Record<string,unknown>;
 if(Object.keys(obj).sort().join(",")!=="digest,expectedVersion,fingerprint,requestId,scope,version"||obj.version!==1||!id(obj.requestId)||typeof obj.fingerprint!=="string"||!hex.test(obj.fingerprint)||typeof obj.digest!=="string"||!hex.test(obj.digest)||!(obj.expectedVersion===null||id(obj.expectedVersion)))throw new Error("Unavailable");
 if(!obj.scope||typeof obj.scope!=="object"||Array.isArray(obj.scope)||Object.keys(obj.scope).sort().join(",")!=="actorId,environment,leaseId,liveOrgId,orgId"||!validScope(obj.scope as V2Scope))throw new Error("Unavailable");return obj as V2Pending;
}
/** Never silently truncate or omit malformed same-namespace entries. */
export function listV2Pending(store:Store,scope:V2Scope):V2Pending[] {
 if(!validScope(scope)||store.length>1000)throw new Error("Unavailable");const result:V2Pending[]=[];let seen=0;
 for(let i=0;i<store.length;i++){const name=store.key(i);if(name===null)throw new Error("Unavailable");if(!name.startsWith(prefix))continue;if(++seen>100)throw new Error("Unavailable");const raw=store.getItem(name);if(raw===null)throw new Error("Unavailable");const item=parse(raw);if(key(item)!==name)throw new Error("Unavailable");if(sameScope(item.scope,scope))result.push(item);}
 return result.sort((a,b)=>a.requestId<b.requestId?-1:a.requestId>b.requestId?1:0);
}
/** Require exact readback immediately after writing and before/after awaits. */
export function assertV2Pending(store:Store,record:V2Pending):void {const raw=store.getItem(key(record));if(raw===null||JSON.stringify(parse(raw))!==JSON.stringify(record))throw new Error("Unavailable");}
export function persistV2Pending(store:Store,record:V2Pending):void {const current=listV2Pending(store,record.scope);if(current.length!==0||store.getItem(key(record))!==null)throw new Error("Unavailable");parse(JSON.stringify(record));store.setItem(key(record),JSON.stringify(record));assertV2Pending(store,record);}
/** Caller must have a current, same-request terminal recorded/closed result. */
export function archiveV2Pending(store:Store,record:V2Pending,terminal:"recorded"|"closed"):void {if(terminal!=="recorded"&&terminal!=="closed")throw new Error("Unavailable");assertV2Pending(store,record);store.removeItem(key(record));if(store.getItem(key(record))!==null)throw new Error("Unavailable");}
/** A later scan may add entries, but cannot lose or replace a known request. */
export function retainV2Pending(known:V2Pending[],observed:V2Pending[]):void {
 for(const record of known)if(!observed.some(item=>JSON.stringify(item)===JSON.stringify(record)))throw new Error("Unavailable");
}
/** A legacy statement request in this tab must be resolved before v2 starts. */
export function hasLegacyStatementPending(store:Store,scope:V2Scope):boolean {
 if(!validScope(scope)||store.length>1000)throw new Error("Unavailable");let found=false;
 for(let i=0;i<store.length;i++){const name=store.key(i);if(name===null)throw new Error("Unavailable");if(!name.startsWith("condola:settlement:"))continue;const parts=name.split(":");if(parts.length!==8||!id(parts[2].toLowerCase())||!id(parts[3].toLowerCase())||!id(parts[4].toLowerCase()))throw new Error("Unavailable");if(parts[2].toLowerCase()!==scope.actorId||parts[3].toLowerCase()!==scope.orgId||parts[4].toLowerCase()!==scope.leaseId||parts[5]!=="statement")continue;if(parts[6]!=="none"||(parts[7]!=="editor"&&parts[7]!=="new-draft"))throw new Error("Unavailable");const value=store.getItem(name);if(value===null||!id(value.toLowerCase()))throw new Error("Unavailable");found=true;}return found;
}
