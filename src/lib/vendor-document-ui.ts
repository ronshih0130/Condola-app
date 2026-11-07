/** Serializable UI contracts; no server dependencies or capability values. */
export type FixedDataUpdate = {
  expectedVersion: number;
  display_name?: string;
  business_name?: string;
  representative_name?: string;
  phone_e164?: string;
  address?: string | null;
  seal?: { base64: string; mimeType: "image/png" | "image/jpeg" };
};

export type DocumentInviteView = {
  profileId: string | null; vendorName: string | null; ready: boolean;
  owners: Array<{ id: string; name: string }>;
  invites: Array<{ id: string; state: 'active' | 'expired' | 'revoked'; expiresAt: string }>;
};
