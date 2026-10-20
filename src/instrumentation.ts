export async function register() {
  const { enforceDemoSafety } = await import("./server/demo");
  enforceDemoSafety();
}
