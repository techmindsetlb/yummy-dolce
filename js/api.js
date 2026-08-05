/**
 * API client for the Cloudflare Worker backend.
 *
 * The admin auth token lives only in memory (never in localStorage),
 * matching the "no local storage, always online & synced" requirement.
 */
import { resolveApiBase } from "./config.js";

const BASE = resolveApiBase();

let authToken = null;

export function setToken(token) {
  authToken = token || null;
}

export function hasToken() {
  return !!authToken;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function apiFetch(path, options = {}) {
  const { headers = {}, body, ...rest } = options;
  const finalHeaders = { ...headers };
  if (body && !(body instanceof FormData) && !(body instanceof Blob) && typeof body !== "string") {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (authToken) finalHeaders["Authorization"] = `Bearer ${authToken}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...rest, headers: finalHeaders, body });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }

  if (res.status === 204) return null;

  let data = null;
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}

/* ------------------------- Public ------------------------- */

export function getMenu() {
  return apiFetch("/api/menu");
}

export function submitOrder(order) {
  return apiFetch("/api/orders", { method: "POST", body: JSON.stringify(order) });
}

/* ------------------------- Admin ------------------------- */

export function login(passcode) {
  return apiFetch("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ passcode }),
  });
}

export function saveMenu(menu) {
  return apiFetch("/api/admin/menu", { method: "PUT", body: JSON.stringify(menu) });
}

export function uploadImage(blob, originalName) {
  return apiFetch("/api/admin/image", {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/webp", "X-Image-Name": originalName || "image.webp" },
    body: blob,
  });
}

export function deleteImage(key) {
  return apiFetch(`/api/admin/image?key=${encodeURIComponent(key)}`, { method: "DELETE" });
}

export function getOrders() {
  return apiFetch("/api/admin/orders");
}

export function updateOrderStatus(id, status) {
  return apiFetch(`/api/admin/orders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function changePasscode(currentPasscode, newPasscode) {
  return apiFetch("/api/admin/passcode", {
    method: "POST",
    body: JSON.stringify({ currentPasscode, newPasscode }),
  });
}
