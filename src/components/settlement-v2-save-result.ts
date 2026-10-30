const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Treat malformed or unrecognized transport results as unknown. */
export function v2SavedId(value:unknown):string|null {
 if(!value||typeof value!=="object"||Array.isArray(value))return null;const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)return null;const result=value as Record<string,unknown>;
 if(Object.keys(result).sort().join(",")!=="freshness,id,ok,recovered"||result.ok!==true||typeof result.id!=="string"||!UUID.test(result.id)||typeof result.recovered!=="boolean"||!(result.freshness==="current"||result.freshness==="unavailable"))return null;return result.id;
}
