export const ID_PURGE_BUCKET = "id-documents-private";

export function assertIdPurgeTarget(target: { bucket: string; path: string }): void {
  if (
    target.bucket !== ID_PURGE_BUCKET ||
    typeof target.path !== "string" ||
    target.path.trim().length === 0 ||
    target.path.startsWith("/") ||
    target.path.includes("..") ||
    target.path.includes("\\")
  ) {
    throw new Error("Unsafe ID purge target");
  }
}

export function idPurgeMayDelete(kind: string): boolean {
  return kind === "id_photo";
}
