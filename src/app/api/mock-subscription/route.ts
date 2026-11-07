import { handleMockSubscriptionWebhook } from '@/server/usage-subscriptions';
import { localMockEnabled } from '@/server/b030-subscription-rules';

export async function POST(request: Request): Promise<Response> {
  if (!localMockEnabled(process.env) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname)) {
    return new Response(null, { status: 404 });
  }
  // Bound even chunked fixture bodies before decoding or authenticating them.
  const stream = request.body?.getReader();
  if (!stream) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await stream.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const result = await handleMockSubscriptionWebhook(raw, request.headers.get('x-mock-timestamp') ?? '', request.headers.get('x-mock-signature') ?? '');
    return Response.json({ result }, { status: result === 'duplicate' ? 409 : 200 });
  } catch {
    return new Response(null, { status: 400 });
  } finally { stream.releaseLock(); }
}
