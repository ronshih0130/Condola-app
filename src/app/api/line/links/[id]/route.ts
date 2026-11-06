import { lineHandlers } from "@/server/line/login-routes";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return lineHandlers.unlink(request, (await context.params).id);
}
