// Synthetic private object store for the B-011 browser test only.
import { createServer } from "node:http";
const objects = new Map();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "e2e-photo-key";
createServer(async (req,res) => {
  if (req.url === "/health") return res.writeHead(200).end("ok");
  if (req.headers.authorization !== `Bearer ${key}` || req.headers.apikey !== key) return res.writeHead(403).end();
  if (!req.url?.startsWith("/storage/v1/object/handover-attachments-private/")) return res.writeHead(404).end();
  const path = req.url;
  if (req.method === "POST") {
    if (objects.has(path)) return res.writeHead(409).end();
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 5242880) return res.writeHead(413).end(); chunks.push(chunk); }
    objects.set(path,Buffer.concat(chunks)); return res.writeHead(200).end();
  }
  if (req.method === "GET") { const object = objects.get(path); return object ? res.writeHead(200).end(object) : res.writeHead(404).end(); }
  if (req.method === "DELETE") { objects.delete(path); return res.writeHead(200).end(); }
  res.writeHead(405).end();
}).listen(4599,"127.0.0.1");
