#!/usr/bin/env node
/**
 * YUMMY DOLCE — local dev server.
 *
 * Serves the static site AND stubs the Cloudflare Worker API in memory, so you
 * can preview the full menu + admin flow before deploying anything.
 *
 *   node dev-server.mjs          # then open http://localhost:8788
 *   DEV_PASSCODE=secret node dev-server.mjs
 *
 * Nothing here is used in production — production runs on GitHub Pages + Workers.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8788;
const DEV_PASSCODE = process.env.DEV_PASSCODE || "Yummy2026#";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

// ---- In-memory "database" (mirrors KV) ----
let menu = null; // loaded lazily from data/seed-menu.json
let passcode = DEV_PASSCODE;
const images = new Map(); // key -> { contentType, buffer }
const orders = new Map(); // id -> order

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Image-Name",
};

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(body);
}

async function getMenu() {
  if (!menu) {
    const raw = await readFile(join(ROOT, "data", "seed-menu.json"), "utf8");
    menu = JSON.parse(raw);
  }
  return menu;
}

function isAuthed(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") && header.length > 7;
}

async function handleApi(req, res, pathname, url) {
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const readBody = () =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  // Public
  if (method === "GET" && pathname === "/api/menu") {
    return sendJson(res, await getMenu());
  }

  if (method === "GET" && pathname.startsWith("/api/images/")) {
    const key = pathname.slice("/api/images/".length);
    const img = images.get(key);
    if (!img) {
      res.writeHead(404, CORS);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": img.contentType || "image/webp",
      "Cache-Control": "public, max-age=31536000",
      ...CORS,
    });
    return res.end(img.buffer);
  }

  if (method === "POST" && pathname === "/api/orders") {
    const body = JSON.parse((await readBody()).toString() || "{}");
    orders.set(body.id, { ...body, status: "new" });
    return sendJson(res, { ok: true }, 201);
  }

  // Auth entry points
  if (method === "POST" && pathname === "/api/admin/login") {
    const body = JSON.parse((await readBody()).toString() || "{}");
    if (body.passcode !== passcode) {
      return sendJson(res, { error: "Incorrect passcode" }, 401);
    }
    return sendJson(res, { token: "dev-token-1234", expiresIn: 43200 });
  }

  if (method === "POST" && pathname === "/api/admin/passcode") {
    const body = JSON.parse((await readBody()).toString() || "{}");
    if (body.currentPasscode !== passcode) {
      return sendJson(res, { error: "Current passcode is incorrect" }, 401);
    }
    passcode = body.newPasscode;
    return sendJson(res, { ok: true });
  }

  // Authenticated
  if (!isAuthed(req)) {
    return sendJson(res, { error: "Unauthorized" }, 401);
  }

  if (method === "PUT" && pathname === "/api/admin/menu") {
    const body = JSON.parse((await readBody()).toString() || "{}");
    menu = { ...body, updatedAt: new Date().toISOString() };
    return sendJson(res, { ok: true, updatedAt: menu.updatedAt });
  }

  if (method === "POST" && pathname === "/api/admin/image") {
    const buf = await readBody();
    const key = `img/${Date.now().toString(36)}.webp`;
    images.set(key, { contentType: req.headers["content-type"] || "image/webp", buffer: buf });
    return sendJson(res, { url: `/api/images/${key}` }, 201);
  }

  if (method === "DELETE" && pathname === "/api/admin/image") {
    images.delete(url.searchParams.get("key") || "");
    return sendJson(res, { ok: true });
  }

  if (method === "GET" && pathname === "/api/admin/orders") {
    return sendJson(res, [...orders.values()].reverse());
  }

  if (method === "PATCH" && pathname.startsWith("/api/admin/orders/")) {
    const id = decodeURIComponent(pathname.slice("/api/admin/orders/".length));
    const order = orders.get(id);
    if (!order) {
      return sendJson(res, { error: "Order not found" }, 404);
    }
    const body = JSON.parse((await readBody()).toString() || "{}");
    order.status = body.status;
    return sendJson(res, { ok: true });
  }

  sendJson(res, { error: "Not found" }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, pathname, url);
  }

  // Static files
  let filePath = normalize(join(ROOT, pathname === "/" ? "index.html" : pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🧁 YUMMY DOLCE dev server → http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin.html`);
  console.log(`   Dev passcode: ${DEV_PASSCODE}`);
});
