// B-031 slice 3 UPLOAD_RECOVERY copy (shown only when the upload_recovery flag is ON).
export type UploadRecoveryCopy = {
  queued: string;
  uploading: string;
  uploaded: string;
  failed: string;
  attached: string;
  reselect: string;
  retry: string;
  submit: string;
  submitting: string;
  submitted: string;
  restored: string;
  leftOut: string;
  list: string;
  remove: string;
  discard: string;
  busy: string;
  trim: string;
};

export function uploadRecoveryCopy(locale: string): UploadRecoveryCopy {
  return locale === "zh-TW"
    ? {
        queued: "等待上傳",
        uploading: "上傳中…",
        uploaded: "已上傳",
        failed: "上傳失敗",
        attached: "已加入報修",
        reselect: "請重新選擇這張照片後再試。",
        retry: "重試失敗的檔案",
        submit: "將 {count} 張已上傳的照片加入報修",
        submitting: "加入中…",
        submitted: "照片已加入報修。",
        restored: "已保留上次上傳的照片，已上傳的照片不會重複加入。",
        leftOut: "上傳失敗的檔案不會加入。可以先重試，或只加入已上傳的照片。",
        list: "照片上傳狀態",
        remove: "移除",
        discard: "捨棄這次的照片",
        busy: "系統忙碌中，照片都還在，請稍後再試一次。",
        trim: "照片超過 8 張上限。請移除幾張後再加入。",
      }
    : {
        queued: "Waiting to upload",
        uploading: "Uploading…",
        uploaded: "Uploaded",
        failed: "Upload failed",
        attached: "Added to the repair",
        reselect: "Choose this photo again to retry.",
        retry: "Retry failed files",
        submit: "Add {count} uploaded photos to the repair",
        submitting: "Adding…",
        submitted: "Photos added to the repair.",
        restored: "Photos from your last attempt are kept. Uploaded photos will not be added twice.",
        leftOut: "Failed files are not added. Retry them first, or add only the uploaded photos.",
        list: "Photo upload status",
        remove: "Remove",
        discard: "Discard these photos",
        busy: "The system is busy. Your photos are kept. Please try again in a moment.",
        trim: "This is over the 8-photo limit. Remove some photos, then try adding again.",
      };
}
