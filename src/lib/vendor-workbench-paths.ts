/** B-063 vendor workbench routes. OFF: /vendor-account is the B-026 account page and the others 404. */
export const VENDOR_WORKBENCH = {
  home: "/vendor-account", jobs: "/vendor-account/jobs", payments: "/vendor-account/payments", account: "/vendor-account/account",
} as const;
export const vendorWorkbenchJobHref = (jobId: string) => `${VENDOR_WORKBENCH.jobs}/${encodeURIComponent(jobId)}`;
export const isVendorWorkbenchPath = (path: string) => path === VENDOR_WORKBENCH.home || path.startsWith(`${VENDOR_WORKBENCH.home}/`);
/** Where the workbench routes send someone with no account session, or with terms that are not current. */
export const VENDOR_WORKBENCH_LOGIN = `/login?next=${encodeURIComponent(VENDOR_WORKBENCH.home)}`;
export const VENDOR_WORKBENCH_CONSENT = `/consent?next=${encodeURIComponent(VENDOR_WORKBENCH.home)}`;
