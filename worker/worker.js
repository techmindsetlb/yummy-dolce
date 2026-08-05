/**
 * YUMMY DOLCE — Cloudflare Worker API
 *
 * Single source of truth for the online menu:
 *   • KV (binding `MENU`)  → menu JSON, order log, passcode hash, rate limits
 *                            AND uploaded product photos (WebP, compressed client-side)
 *
 * Endpoints:
 *   Public
 *     GET  /api/menu                        → { business, categories, updatedAt }
 *     GET  /api/images/{key}                → stored image
 *     POST /api/orders                      → log an order (best-effort, used by checkout)
 *   Admin (token issued by login)
 *     POST /api/admin/login                 { passcode } → { token }
 *     PUT  /api/admin/menu                  replace the whole menu
 *     POST /api/admin/image                 raw image bytes (image/*, ≤ 6 MB) → stored in KV
 *     DELETE /api/admin/image?key=img/...
 *     GET  /api/admin/orders                → list of logged orders (newest first)
 *     PATCH /api/admin/orders/{id}          { status: "new" | "contacted" | "done" }
 *     DELETE /api/admin/orders/{id}         → remove an order permanently
 *     POST /api/admin/passcode              { currentPasscode, newPasscode }
 *
 * Secrets (set with `wrangler secret put`):
 *   ADMIN_SECRET    — random string used to sign admin tokens (required)
 *   ADMIN_PASSCODE  — initial admin passcode, used until changed in Settings
 */

const ORDER_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_MENU_BYTES = 2 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 12;
const LOGIN_WINDOW_SECONDS = 600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Image-Name",
      "Access-Control-Max-Age": "86400",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (data, status = 200, extra = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra },
      });

    const fail = (msg, status = 400) => json({ error: msg }, status);

    try {
      // ---- Public ----
      if (method === "GET" && path === "/api/menu") return handleGetMenu(env, json);
      if (method === "GET" && path.startsWith("/api/images/")) {
        return handleGetImage(path, env, cors);
      }
      if (method === "POST" && path === "/api/orders") return handlePostOrder(request, env, json, fail);

      // ---- Admin auth entry points ----
      if (method === "POST" && path === "/api/admin/login") return handleLogin(request, env, json, fail);
      if (method === "POST" && path === "/api/admin/passcode") return handleChangePasscode(request, env, json, fail);

      // ---- Authenticated admin ----
      const auth = await requireAuth(request, env);
      if (auth !== true) return auth;

      if (method === "PUT" && path === "/api/admin/menu") return handlePutMenu(request, env, json, fail);
      if (method === "POST" && path === "/api/admin/image") return handleUploadImage(request, env, json, fail);
      if (method === "DELETE" && path === "/api/admin/image") return handleDeleteImage(url, env, json, fail);
      if (method === "GET" && path === "/api/admin/orders") return handleListOrders(env, json);
      if (method === "PATCH" && path.startsWith("/api/admin/orders/")) {
        return handlePatchOrder(request, path, env, json, fail);
      }
      if (method === "DELETE" && path.startsWith("/api/admin/orders/")) {
        return handleDeleteOrder(path, env, json, fail);
      }

      return fail("Not found", 404);
    } catch (err) {
      console.error("worker error:", err);
      return fail("Internal server error", 500);
    }
  },
};

/* ============================ Public ============================ */

async function handleGetMenu(env, json) {
  const raw = await env.MENU.get("menu:current");
  if (!raw) return json({ business: null, categories: [], updatedAt: null, empty: true });
  try {
    return json(JSON.parse(raw));
  } catch {
    return json({ business: null, categories: [], updatedAt: null, empty: true });
  }
}

async function handleGetImage(path, env, cors) {
  const key = path.slice("/api/images/".length);
  if (!key) return new Response("Not found", { status: 404, headers: cors });
  const buf = await env.MENU.get(key, "arrayBuffer");
  if (!buf) return new Response("Not found", { status: 404, headers: cors });
  let contentType = "image/webp";
  try {
    const meta = JSON.parse((await env.MENU.get("imgmeta:" + key)) || "{}");
    if (meta.contentType) contentType = meta.contentType;
  } catch {
    /* fall back to webp */
  }
  return new Response(buf, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...cors,
    },
  });
}

async function handlePostOrder(request, env, json, fail) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body");
  }

  // Validate before consuming an order number, so failed requests don't skip a number.
  const total = Number(body.total);
  if (Number.isNaN(total)) return fail("Invalid total");

  const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];

  // Sequential order number from a KV counter — starts at 0001, never repeats.
  const rawCount = await env.MENU.get("counter:order");
  const next = (parseInt(rawCount || "0", 10) || 0) + 1;
  await env.MENU.put("counter:order", String(next));
  const id = String(next).padStart(4, "0");

  const record = {
    id,
    source: String(body.source || "site").slice(0, 20),
    items: items.map((i) => ({
      name: String(i.name || "Item").slice(0, 80),
      qty: Math.max(1, Math.min(99, Number(i.qty) || 1)),
      unitPrice: Number(i.unitPrice) || 0,
      category: String(i.category || "").slice(0, 40),
      options: (Array.isArray(i.options) ? i.options : [])
        .map((o) => String(o).slice(0, 80))
        .slice(0, 12),
    })),
    total: Math.round(total * 100) / 100,
    name: String(body.name || "").slice(0, 120),
    phone: String(body.phone || "").slice(0, 40),
    address: String(body.address || "").slice(0, 300),
    note: String(body.note || "").slice(0, 400),
    status: "new",
    createdAt: new Date().toISOString(),
  };

  await env.MENU.put(`orders:${id}`, JSON.stringify(record), {
    expirationTtl: ORDER_TTL_SECONDS,
  });
  return json({ ok: true, id }, 201);
}

/* ============================ Auth ============================ */

async function handleLogin(request, env, json, fail) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:${ip}`;
  const attempts = Number((await env.MENU.get(rlKey)) || 0);
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    return fail("Too many attempts. Try again in 10 minutes.", 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid body");
  }

  const ok = await verifyPasscode(String(body.passcode || ""), env);
  if (!ok) {
    await env.MENU.put(rlKey, String(attempts + 1), { expirationTtl: LOGIN_WINDOW_SECONDS });
    return fail("Incorrect passcode", 401);
  }

  await env.MENU.delete(rlKey).catch(() => {});

  const token = await issueToken(env);
  if (!token) return fail("Server is missing ADMIN_SECRET", 500);
  return json({ token, expiresIn: TOKEN_TTL_SECONDS });
}

async function handleChangePasscode(request, env, json, fail) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid body");
  }
  const current = String(body.currentPasscode || "");
  const next = String(body.newPasscode || "");
  if (next.length < 6) return fail("New passcode must be at least 6 characters");

  const ok = await verifyPasscode(current, env);
  if (!ok) return fail("Current passcode is incorrect", 401);

  const hash = await sha256Hex(next);
  await env.MENU.put("settings:passcode", hash);
  return json({ ok: true });
}

async function verifyPasscode(passcode, env) {
  const stored = await env.MENU.get("settings:passcode");
  if (stored) {
    const hash = await sha256Hex(passcode);
    return hash === stored;
  }
  return !!env.ADMIN_PASSCODE && passcode === env.ADMIN_PASSCODE;
}

async function requireAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return unauthorized();

  const [part, sig] = token.split(".");
  if (!part || !sig) return unauthorized();

  try {
    const expected = await sign(part, env.ADMIN_SECRET);
    if (expected !== sig) return unauthorized();
    const payload = JSON.parse(unb64url(part));
    const now = Math.floor(Date.now() / 1000);
    if (payload.sub !== "admin" || payload.exp < now) return unauthorized();
  } catch {
    return unauthorized();
  }
  return true;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function issueToken(env) {
  if (!env.ADMIN_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "admin", iat: now, exp: now + TOKEN_TTL_SECONDS };
  const part = b64url(JSON.stringify(payload));
  const sig = await sign(part, env.ADMIN_SECRET);
  return `${part}.${sig}`;
}

async function sign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

/* ============================ Admin: menu ============================ */

async function handlePutMenu(request, env, json, fail) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.business !== "object" ||
    body.business === null ||
    !Array.isArray(body.categories)
  ) {
    return fail("Menu must contain a business object and a categories array");
  }

  const raw = JSON.stringify(body);
  if (raw.length > MAX_MENU_BYTES) return fail("Menu is too large");

  const updatedAt = new Date().toISOString();
  body.updatedAt = updatedAt;
  await env.MENU.put("menu:current", JSON.stringify(body));
  return json({ ok: true, updatedAt });
}

/* ============================ Admin: images ============================ */

async function handleUploadImage(request, env, json, fail) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("image/")) {
    return fail("Only image uploads are allowed", 415);
  }

  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_IMAGE_BYTES) return fail("Image is too large (max 6 MB)", 413);

  const originalName = String(request.headers.get("X-Image-Name") || "image.webp").slice(0, 100);
  const dot = originalName.lastIndexOf(".");
  const ext = dot >= 0 ? originalName.slice(dot + 1).toLowerCase().slice(0, 6) : "webp";
  const safeExt = /^[a-z0-9]{2,6}$/.test(ext) ? ext : "webp";

  const key = `img/${crypto.randomUUID()}.${safeExt}`;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) return fail("Image is too large (max 6 MB)", 413);
  await env.MENU.put(key, buf);
  // Content-type lives under a separate `imgmeta:` prefix (distinct from `img/`,
  // so any future listing of image keys stays clean).
  await env.MENU.put("imgmeta:" + key, JSON.stringify({ contentType }));
  return json({ url: `/api/images/${key}` }, 201);
}

async function handleDeleteImage(url, env, json, fail) {
  const key = url.searchParams.get("key") || "";
  if (!key || !key.startsWith("img/")) return fail("Missing or invalid image key");
  await env.MENU.delete(key);
  await env.MENU.delete("imgmeta:" + key);
  return json({ ok: true });
}

/* ============================ Admin: orders ============================ */

async function handleListOrders(env, json) {
  const list = await env.MENU.list({ prefix: "orders:" });
  const orders = [];
  for (const item of list.keys) {
    if (orders.length >= 300) break;
    const raw = await env.MENU.get(item.name);
    if (!raw) continue;
    try {
      orders.push(JSON.parse(raw));
    } catch {
      /* skip corrupt entries */
    }
  }
  orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return json(orders);
}

async function handleDeleteOrder(path, env, json, fail) {
  const id = decodeURIComponent(path.slice("/api/admin/orders/".length));
  if (!id) return fail("Missing order id");
  const raw = await env.MENU.get(`orders:${id}`);
  if (!raw) return fail("Order not found", 404);
  await env.MENU.delete(`orders:${id}`);
  return json({ ok: true });
}

async function handlePatchOrder(request, path, env, json, fail) {
  const id = decodeURIComponent(path.slice("/api/admin/orders/".length));
  if (!id) return fail("Missing order id");

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid body");
  }

  const status = ["new", "contacted", "done"].includes(body.status) ? body.status : null;
  if (!status) return fail("Invalid status");

  const raw = await env.MENU.get(`orders:${id}`);
  if (!raw) return fail("Order not found", 404);

  const order = JSON.parse(raw);
  order.status = status;
  await env.MENU.put(`orders:${id}`, JSON.stringify(order), {
    expirationTtl: ORDER_TTL_SECONDS,
  });
  return json({ ok: true });
}

/* ============================ Crypto helpers ============================ */

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
