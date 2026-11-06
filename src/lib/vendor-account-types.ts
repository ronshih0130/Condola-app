export type VendorAccountHistory = {
  settings: { orgId: string; contactId: string; name: string }[];
  jobs: { jobId: string; orgId: string; ticketId: string; status: string; description: string | null; readOnly: boolean }[];
};
