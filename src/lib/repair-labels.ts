export const REPAIR_CATS = [
  "plumbing",
  "electrical",
  "appliance",
  "hvac",
  "structural",
  "pest",
  "locks_keys",
  "internet",
  "cleaning",
  "other",
] as const;

export const REPAIR_CAT_KEY: Record<string, string> = {
  plumbing: "i_cat_plumbing",
  electrical: "i_cat_electrical",
  appliance: "i_cat_appliance",
  hvac: "i_cat_hvac",
  structural: "i_cat_structural",
  pest: "i_cat_pest",
  locks_keys: "i_cat_locks",
  internet: "i_cat_internet",
  cleaning: "i_cat_cleaning",
  other: "i_cat_other",
};

export const REPAIR_STATUSES = ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"] as const;

export const COST_BEARER_KEY: Record<string, string> = {
  owner: "i_bearer_owner",
  tenant: "i_bearer_tenant",
  manager: "i_bearer_manager",
  split: "i_bearer_split",
  undecided: "i_bearer_undecided",
};
