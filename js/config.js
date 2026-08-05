/**
 * YUMMY DOLCE — central configuration.
 *
 * API_BASE is the URL of your deployed Cloudflare Worker.
 * After deploying the worker (see README.md), paste its URL here, e.g.
 *   "https://yummy-dolce-api.your-subdomain.workers.dev"
 *
 * The site NEVER stores data locally — the menu always comes from this API,
 * so any change made in the admin panel is instantly synced for everyone.
 */
export const API_BASE = "https://yummydolce.techmindset-leb.workers.dev";

/** Static sample menu shipped with the repo (used by the admin "Load sample" button). */
export const SEED_MENU_URL = "data/seed-menu.json";

/** Default WhatsApp number (international format, no +). */
export const DEFAULT_WHATSAPP = "96176707832";

export const SITE_DEFAULTS = {
  name: "YUMMY DOLCE",
  tagline: "Handmade sweets, baked fresh",
  about: "Handmade cookies, brownies & bites with 100% Belgian chocolate.",
  delivery: "Beirut – Dahye",
  hours: "Open daily · 10:00 – 20:00",
  currency: "$",
  orderPrefix: "YD",
  whatsapp: DEFAULT_WHATSAPP,
  instagram: "https://www.instagram.com/yummy.dolce/",
  facebook: "",
  tiktok: "",
};

/**
 * Resolve the API base to use.
 * If API_BASE still contains the placeholder (not configured yet), fall back
 * to same-origin "/api" — this is what makes the bundled dev server work.
 */
let _resolvedBase = null;
export function resolveApiBase() {
  if (_resolvedBase !== null) return _resolvedBase;
  _resolvedBase = !API_BASE || API_BASE.includes("YOUR_SUBDOMAIN") ? "" : API_BASE;
  return _resolvedBase;
}

/** Build an absolute URL from a possibly-relative API path. */
export function toAbs(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return resolveApiBase() + url;
  return url;
}

/** WhatsApp number → wa.me link with an optional pre-filled message. */
export function waLink(number, message = "") {
  const clean = String(number || DEFAULT_WHATSAPP).replace(/[^0-9]/g, "").replace(/^0+/, "");
  return `https://wa.me/${clean}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
}
