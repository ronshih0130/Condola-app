import { createHash } from 'node:crypto';
import type { Session } from './types';

/** The version binds the displayed row to the server-resolved actor and live scope. */
export function staffProfileVersion(session: Pick<Session,'userId'|'orgId'|'liveOrgId'|'sessionId'|'environment'>, updatedAt:string, name:string|null):string {
  return createHash('sha256').update(JSON.stringify([session.userId,session.orgId,session.liveOrgId,session.sessionId,session.environment,updatedAt,name])).digest('hex');
}
export function parseStaffDisplayName(value:unknown):string|null {
  if(typeof value!=='string')return null;
  const name=value.trim();
  if(!name || Array.from(name).length>100 || Buffer.byteLength(name,'utf8')>400 || /[\u0000-\u001f\u007f-\u009f]/u.test(name))return null;
  return name;
}
export function validStaffProfileVersion(value:unknown):value is string { return typeof value==='string' && /^[0-9a-f]{64}$/.test(value); }
