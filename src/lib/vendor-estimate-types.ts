/** Serializable estimate view models. No runtime server dependencies. */
export type VendorEstimateContext = {
  headId: string | null; currency: string; minorUnit: number; photos: { id: string }[];
};
export type VendorEstimateResult = { status: string; [key: string]: unknown };
