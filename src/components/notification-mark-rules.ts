/** Extract only the token from the exact current vendor notification pathname. */
export function vendorTokenFromNotificationPath(path:string):string|null {
  const match=/^\/v\/([^/]+)\/notifications$/.exec(path);
  if(!match) return null;
  try {const value=decodeURIComponent(match[1]);return /^[A-Za-z0-9_-]{43,256}$/.test(value)?value:null;} catch {return null;}
}
export function notificationMarkResult(ok:boolean,value:unknown):"busy"|"marked"|"unknown" {
  if(!ok || !value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).join(",")!=="status" || !("status" in value)) return "unknown";
  return value.status==="busy" || value.status==="marked" ? value.status : "unknown";
}

export type MarkDisplayState="idle"|"busy"|"unknown"|"unknownBusy";
export function afterBusyMark(previous:MarkDisplayState):MarkDisplayState {
  return previous==="unknown" || previous==="unknownBusy" ? "unknownBusy" : "busy";
}
