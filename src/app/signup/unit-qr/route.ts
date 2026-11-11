export const dynamic = "force-dynamic";

const RETIRED_HTML = `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>這個 QR 已停用</title>
</head>
<body>
<main>
<p>管理公司</p>
<h1>這個 QR 已停用</h1>
<p>這是舊版的申請 QR，已經不能用了。請跟管理公司拿最新的邀請，掃完用 LINE 就能加入。</p>
</main>
</body>
</html>`;

export function GET() {
  return new Response(RETIRED_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    },
  });
}
