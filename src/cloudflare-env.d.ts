interface CloudflareEnv {
  /** Present on staging and production after `wrangler hyperdrive create`. Absent locally. */
  HYPERDRIVE?: { connectionString: string };
}
