// B-031 UPLOAD_RECOVERY shared shapes (no runtime code; safe for the browser bundle).
export type UploadItemState = "signed" | "uploaded" | "attached";

export type UploadRecoveryDraft = {
  batchKey: string;
  internal: boolean;
  items: { clientKey: string; name: string; state: UploadItemState }[];
};

/** null = flag OFF (render the existing uploader). */
export type UploadRecoveryView = { draft: UploadRecoveryDraft | null } | null;
