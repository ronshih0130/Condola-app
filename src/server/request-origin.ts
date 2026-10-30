/** Narrow the framework URL's origin with the original Host representation.
 * Host is a consistency check, never an alternative origin or proxy fallback.
 * The adapter/proxy remains responsible for deriving trustworthy URL protocol
 * and headers; discarded duplicate wire headers cannot be detected here.
 */
export function sameOriginMutation(request:Request):boolean{
 const origin=request.headers.get('origin'),host=request.headers.get('host'),site=request.headers.get('sec-fetch-site');
 if(!origin||!host||(site!==null&&site!=='same-origin')||/[\s,/@\\?#\u0000-\u001f\u007f]/u.test(host))return false;
 try{
  // Ordinary WHATWG URL, not NextURL's loopback-host normalization.
  const target=new URL(request.url),supplied=new URL(origin);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||supplied.protocol!==target.protocol||supplied.origin!==origin||supplied.username||supplied.password||supplied.origin!==target.origin)return false;
  const authority=new URL(`${target.protocol}//${host}`);
  if(!authority.hostname||authority.username||authority.password||authority.pathname!=='/'||authority.search||authority.hash)return false;
  return authority.host===target.host;
 }catch{return false;}
}
