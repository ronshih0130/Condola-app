export async function register() {
  const { enforceDemoSafety } = await import("./server/demo");
  enforceDemoSafety();
  const { assertIdDocKeys } = await import("./server/id-keys");
  assertIdDocKeys();
}
