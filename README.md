# 🧁 YUMMY DOLCE — Online Menu

A gift for a small sweets business: a beautiful online menu with **add-to-cart** and
**checkout that sends the order straight to WhatsApp**, plus a passcode-protected
admin panel to manage everything.

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│  Customers (browser)        │         │  Cloudflare Worker  (worker/worker.js)│
│  index.html  (GitHub Pages) │  HTTPS  │  • /api/menu      → JSON in KV        │
│  admin.html  (passcode)     │ ──────► │  • /api/images/*  → photos in KV      │
│                             │         │  • /api/orders    → order log (KV)    │
└─────────────────────────────┘         └──────────────────────────────────────┘
```

- **Site** → hosted free on **GitHub Pages** (no build step, just push).
- **Data** → lives in **Cloudflare KV** (menu JSON, order log, and product photos).
  **No R2, no credit card** — the whole backend runs on the Workers free plan.
- **Synced & online** → nothing is stored in customers' localStorage; the site always
  fetches the latest menu. Edit once in the admin → everyone sees it instantly.
- **Photos** → uploaded photos are compressed and converted to **WebP** in the browser
  before upload, so the site stays fast.
- **Orders** → checkout opens WhatsApp with a formatted order message **and** logs the
  order server-side, so the owner can track orders even if a message is missed.

---

## 1. Prerequisites

| What | Why | Cost |
|---|---|---|
| A **GitHub** account | Host the site on GitHub Pages | Free |
| A **Cloudflare** account | Run the Worker + KV (no card needed) | Free tier |
| **Node.js 18+** | Run the `wrangler` CLI | Free |

Check Node is installed: `node -v` (if not, install from https://nodejs.org).

---

## 2. Deploy the backend (Cloudflare Worker)

The Worker is the brain — it serves the menu and powers the admin panel.

### 2.1 Install wrangler & log in

```bash
npm install -g wrangler
npx wrangler login
```

Your browser will open to authorize Cloudflare.

### 2.2 Create the storage

```bash
# KV namespace (holds menu JSON, order log, passcode AND product photos)
npx wrangler kv namespace create MENU
```

Copy the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

> 💡 **No R2, no credit card.** Product photos are stored in the same KV namespace
> as the menu (compressed to WebP in the browser first), so the entire backend
> runs on the Workers **free** plan — no payment method is ever required.

### 2.3 Set the secrets

```bash
# Random string that signs admin login tokens — generate one, e.g.:
npx wrangler secret put ADMIN_SECRET
# → paste a long random string, e.g. from: openssl rand -hex 32

# The initial admin passcode (changeable later in the admin → Settings)
npx wrangler secret put ADMIN_PASSCODE
# → paste the passcode, e.g. Yummy2026#
```

> ⚠️ `wrangler.toml` contains a placeholder KV id. If you paste the real id, do **not**
> commit it to a public repo (the id alone isn't a secret, but keep the file tidy —
> the id is safe to commit; **secrets are only ever set via `wrangler secret put`**).

### 2.4 Deploy

```bash
npx wrangler deploy
```

You'll get a URL like `https://yummy-dolce-api.<your-subdomain>.workers.dev`.

### 2.5 Point the site at it

Open **`js/config.js`** and replace the placeholder:

```js
export const API_BASE = "https://yummy-dolce-api.<your-subdomain>.workers.dev";
```

---

## 3. Deploy the site (GitHub Pages)

1. Create a **new GitHub repository** (public or private — either works).
2. Push this folder:
   ```bash
   git init
   git add .
   git commit -m "Yummy Dolce online menu"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. In the repo on GitHub: **Settings → Pages → Source: GitHub Actions**.
   The included workflow (`.github/workflows/deploy-pages.yml`) builds & publishes
   automatically on every push to `main`.
4. Your site is live at `https://<you>.github.io/<repo>/`.

**Admin panel:** `https://<you>.github.io/<repo>/admin.html` — unlock with the
admin passcode, press **"Load sample menu"** (the menu from the printed poster,
already built in), review it, then **Save changes**.

> The very first time, before the sample menu is saved, customers will see a
> friendly "menu coming soon" screen.

---

## 4. Using it day to day

### For customers
- Browse the menu → tap **Add** (or *Choose options* for sizes/flavors) → **Order**
  → fill name/notes → **Checkout on WhatsApp**. A ready-made order message opens in
  WhatsApp with the business number, and the order is also logged in the admin's
  **Orders** tab.

### For the owner (`admin.html`)
- **Menu** — add / edit / delete categories and items, reorder them, upload photos
  (auto-compressed to WebP ≤ 1400 px), set sizes/flavors/extras with prices.
- **Orders** — every order from the site is logged here automatically with a status
  (New / Contacted / Done) so none get missed.
- **Settings** — brand details, WhatsApp number, delivery area, social links, and
  the passcode (change it any time).

---

## 5. Project structure

```
├── index.html            Customer menu page
├── admin.html            Passcode-protected admin panel
├── css/
│   ├── tokens.css        Design tokens (palette, type, spacing)
│   ├── site.css          Customer site styles
│   └── admin.css         Admin panel styles
├── js/
│   ├── config.js         ⚙ API_BASE + defaults (edit this)
│   ├── api.js            Worker API client
│   ├── app.js            Customer site logic (render, cart, WhatsApp checkout)
│   ├── admin.js          Admin panel logic (CRUD, orders, settings)
│   ├── cart.js           In-memory cart (no localStorage)
│   ├── icons.js          SVG icon set
│   ├── image-utils.js    Browser-side compression → WebP
│   └── ui.js             Toasts, modals, reveals
├── worker/
│   └── worker.js         Cloudflare Worker (KV API)
├── data/
│   └── seed-menu.json    Sample menu from the printed poster
├── wrangler.toml         Worker config (paste KV id here)
└── .github/workflows/    GitHub Pages deploy
```

---

## 6. Local preview (before deploying)

Use the bundled dev server — it serves the site **and** stubs the Worker API in
memory, so the menu, cart, WhatsApp checkout and admin panel all work locally:

```bash
node dev-server.mjs
# → http://localhost:8788  (admin: /admin.html, dev passcode: Yummy2026#)
```

As long as `API_BASE` in `js/config.js` is still the placeholder, the site
automatically talks to the same-origin `/api` provided by this dev server.
Once you deploy the Worker and paste its URL into `API_BASE`, production uses
the real backend — no other changes needed.

Alternatively, `npx serve .` or `python -m http.server 8080` work for a pure
static preview, but the menu will show the "can't reach the menu" state because
those servers don't implement the API.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| Site shows "can't reach the menu" | Worker not deployed yet, or `API_BASE` in `js/config.js` is still the placeholder. |
| Admin login says incorrect passcode | Use the passcode set via `wrangler secret put ADMIN_PASSCODE` (first login), or the one changed in Settings later. |
| Too many login attempts | Wait ~10 minutes — failed logins are rate-limited per IP. |
| Photo upload fails | Photos must be images; max 6 MB. The site compresses to ~1400 px WebP before upload. |
| New photo doesn't appear right away | KV is eventually consistent — a freshly uploaded photo can take up to ~60 seconds to show on all devices. |
| GitHub Pages shows old version | Push again to `main` — the Actions workflow redeploys automatically. |
| WhatsApp doesn't open | Confirm `Business → WhatsApp number` in admin Settings is in international format (`961…`, no `+`). |

---

Made with ♥ for Yummy Dolce. `76 707832` · Delivery Beirut – Dahye
