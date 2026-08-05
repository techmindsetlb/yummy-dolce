/**
 * YUMMY DOLCE — customer site.
 *
 * Loads the menu live from the Cloudflare Worker (single source of truth),
 * manages an in-memory cart, and sends orders to WhatsApp.
 * No data is stored in localStorage.
 */
import { SITE_DEFAULTS, toAbs, waLink } from "./config.js";
import { icons } from "./icons.js";
import * as api from "./api.js";
import { cart, round2 } from "./cart.js";
import {
  escapeHtml,
  fmtPrice,
  toast,
  openModal,
  closeModal,
  isModalOpen,
  initModalControls,
  observeReveals,
} from "./ui.js";

/* ------------------------- State ------------------------- */

let business = { ...SITE_DEFAULTS };
let categories = [];

const $ = (id) => document.getElementById(id);

const els = {
  brandName: $("brand-name"),
  footerBrand: $("footer-brand"),
  footerAbout: $("footer-about"),
  deliveryPillText: $("delivery-pill-text"),
  heroEyebrow: $("hero-eyebrow"),
  heroTitle: $("hero-title"),
  heroLede: $("hero-lede"),
  heroWhatsapp: $("hero-whatsapp"),
  marqueeTrack: $("marquee-track"),
  menuRoot: $("menu-root"),
  cartBtn: $("cart-btn"),
  cartBadge: $("cart-badge"),
  cartBar: $("cart-bar"),
  cartBarCount: $("cart-bar-count"),
  cartBarTotal: $("cart-bar-total"),
  cartBarOpen: $("cart-bar-open"),
  drawer: $("cart-drawer"),
  drawerBody: $("drawer-body"),
  drawerFoot: $("drawer-foot"),
  drawerTotal: $("drawer-total"),
  drawerHintText: $("drawer-hint-text"),
  drawerClose: $("drawer-close"),
  checkoutBtn: $("checkout-btn"),
  overlay: $("overlay"),
  header: $("site-header"),
  footerDelivery: $("footer-delivery"),
  footerPhone: $("footer-phone"),
  footerPhoneText: $("footer-phone-text"),
  footerHours: $("footer-hours"),
  footerHoursText: $("footer-hours-text"),
  footerSocials: $("footer-socials"),
};

let drawerOpen = false;

/* ------------------------- Business chrome ------------------------- */

function renderBusiness() {
  const b = business;

  els.brandName.textContent = b.name || SITE_DEFAULTS.name;
  els.footerBrand.textContent = b.name || SITE_DEFAULTS.name;
  els.footerAbout.textContent = b.about || SITE_DEFAULTS.about;
  els.deliveryPillText.textContent = b.delivery || SITE_DEFAULTS.delivery;
  els.footerDelivery.querySelector("span").textContent = b.delivery || SITE_DEFAULTS.delivery;

  els.heroEyebrow.textContent = b.tagline || SITE_DEFAULTS.tagline;
  els.heroLede.textContent = b.about || SITE_DEFAULTS.about;

  const wa = waLink(b.whatsapp);
  els.heroWhatsapp.href = wa;
  els.footerPhone.href = wa;
  els.footerPhoneText.textContent = formatPhone(b.whatsapp);

  if (b.hours) {
    els.footerHoursText.textContent = b.hours;
  } else {
    els.footerHours.style.display = "none";
  }

  // Footer socials — WhatsApp always, others only when a link is set
  const socials = [
    { key: "whatsapp", href: wa },
    { key: "instagram", href: b.instagram },
    { key: "tiktok", href: b.tiktok },
    { key: "facebook", href: b.facebook },
  ];
  const iconsMap = { instagram: icons.instagram, whatsapp: icons.whatsapp, tiktok: icons.tiktok, facebook: icons.facebook };
  // Only http(s) links are allowed — never render javascript: etc.
  const safeHref = (url) => (/^https?:\/\//i.test(url || "") ? url : "");
  els.footerSocials.innerHTML = socials
    .filter((s) => safeHref(s.href))
    .map(
      (s) =>
        `<a href="${escapeHtml(safeHref(s.href))}" target="_blank" rel="noopener" aria-label="${s.key}">${iconsMap[s.key]}</a>`
    )
    .join("");

  // Marquee ribbon
  const bits = [
    "Freshly baked daily",
    `Delivery · ${b.delivery || "Beirut – Dahye"}`,
    `Order on WhatsApp · ${formatPhone(b.whatsapp)}`,
    "100% Belgian chocolate",
  ];
  const item = (text) =>
    `<span class="marquee-item"><span class="heart-mark">${icons.heart}</span><span>${escapeHtml(text)}</span></span>`;
  els.marqueeTrack.innerHTML = [...bits, ...bits].map(item).join("");
}

function formatPhone(number) {
  const clean = String(number || "").replace(/[^0-9]/g, "");
  if (clean.length > 6) return `${clean.slice(0, clean.length - 6)} ${clean.slice(-6)}`;
  return clean || "—";
}

/* ------------------------- Menu rendering ------------------------- */

function itemBasePrice(item) {
  if (item.price != null && item.price !== "" && !Number.isNaN(Number(item.price))) {
    return Number(item.price);
  }
  let total = 0;
  let any = false;
  for (const g of item.optionGroups || []) {
    if (g.required && !g.multiple) {
      const prices = (g.choices || []).map((c) => Number(c.price)).filter((n) => !Number.isNaN(n));
      if (prices.length) {
        total += Math.min(...prices);
        any = true;
      }
    }
  }
  return any ? total : null;
}

function hasPricedGroups(item) {
  return (item.optionGroups || []).some((g) => (g.choices || []).some((c) => c.price != null && !Number.isNaN(Number(c.price))));
}

function itemPriceHtml(item) {
  const base = itemBasePrice(item);
  if (base == null) return "";
  const isFrom = hasPricedGroups(item);
  return isFrom
    ? `<span class="item-price"><span class="from">from</span>${fmtPrice(business.currency, base)}</span>`
    : `<span class="item-price">${fmtPrice(business.currency, base)}</span>`;
}

function mediaHtml(item, ratio = "4 / 3") {
  const src = toAbs(item.image);
  if (src) {
    return `<div class="item-media" style="aspect-ratio:${ratio}"><img src="${escapeHtml(src)}" alt="${escapeHtml(item.name)}" loading="lazy" /></div>`;
  }
  const monogram = (item.name || "YD")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return `<div class="item-media" style="aspect-ratio:${ratio}"><div class="item-placeholder"><span class="ph-mono">${escapeHtml(monogram)}</span>${icons.heart}</div></div>`;
}

function renderMenu() {
  const root = els.menuRoot;

  if (!categories.length) {
    root.innerHTML = `
      <div class="state-box">
        <div class="state-icon">${icons.box}</div>
        <h3>Our menu is on its way</h3>
        <p>The sweets are baking! Check back soon to browse the full menu and order on WhatsApp.</p>
      </div>`;
    observeReveals(root);
    return;
  }

  root.innerHTML = categories
    .map((cat, i) => {
      const items = [...cat.items].sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const colsClass = items.length > 3 ? "cols-4" : "";
      return `
        <section class="category" data-reveal>
          <div class="category-head">
            <span class="category-num">${String(i + 1).padStart(2, "0")}</span>
            <h3 class="category-name">${escapeHtml(cat.name)}</h3>
            ${cat.subtitle ? `<span class="category-sub">${escapeHtml(cat.subtitle)}</span>` : ""}
          </div>
          <div class="category-grid ${colsClass}">
            ${items.map((item) => itemCardHtml(item)).join("")}
          </div>
        </section>`;
    })
    .join("");

  root.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => onAddItem(btn.dataset.add));
  });

  observeReveals(root);
}

function itemCardHtml(item) {
  return `
    <article class="item-card" data-reveal>
      ${mediaHtml(item)}
      <div class="item-body">
        <div class="item-name-row">
          <h4 class="item-name">${escapeHtml(item.name)}</h4>
          ${itemPriceHtml(item)}
        </div>
        ${item.description ? `<p class="item-desc">${escapeHtml(item.description)}</p>` : ""}
        <button class="btn btn-primary item-add" type="button" data-add="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">
          ${icons.plus}
          <span>${hasRequiredGroups(item) ? "Choose options" : "Add"}</span>
        </button>
      </div>
    </article>`;
}

function hasRequiredGroups(item) {
  return (item.optionGroups || []).some((g) => g.required);
}

function findItem(id) {
  for (const cat of categories) {
    const found = (cat.items || []).find((i) => i.id === id);
    if (found) return found;
  }
  return null;
}

/** Category name of an item — some item names repeat across categories (e.g. "Original"). */
function findItemCategory(itemId) {
  for (const cat of categories) {
    if ((cat.items || []).some((i) => i.id === itemId)) return cat.name || "";
  }
  return "";
}

/* ------------------------- Adding to cart ------------------------- */

function onAddItem(id) {
  const item = findItem(id);
  if (!item) return;
  if (hasRequiredGroups(item)) {
    openItemModal(item);
  } else {
    addLine(makeLine(item, {}, 1));
    toast(`Added ${item.name} to your order`);
  }
}

function makeLine(item, selection, qty) {
  const lines = [];
  let unit = Number(item.price) || 0;
  for (const g of item.optionGroups || []) {
    const sel = selection[g.id];
    const chosen = Array.isArray(sel) ? sel : sel ? [sel] : [];
    for (const cid of chosen) {
      const c = (g.choices || []).find((x) => x.id === cid);
      if (!c) continue;
      lines.push({ text: c.label, price: Number(c.price) || 0, kind: g.multiple ? "addon" : "opt" });
      unit += Number(c.price) || 0;
    }
  }
  const key = `${item.id}|${lines.map((l) => l.text).join("~")}`;
  return {
    key,
    itemId: item.id,
    name: item.name,
    catName: findItemCategory(item.id),
    image: item.image,
    qty,
    unitPrice: round2(unit),
    lines,
  };
}

function addLine(line) {
  cart.add(line);
  bumpBadge();
}

function bumpBadge() {
  const badge = els.cartBadge;
  badge.classList.remove("bump");
  void badge.offsetWidth; // restart animation
  badge.classList.add("bump");
}

/* ------------------------- Option picker modal ------------------------- */

function openItemModal(item) {
  const groups = item.optionGroups || [];
  const selection = {};
  const qty = { n: 1 };

  // Pre-select the first choice of each required single-choice group
  for (const g of groups) {
    if (g.required && !g.multiple && g.choices.length) {
      selection[g.id] = g.choices[0].id;
    }
    if (g.multiple) selection[g.id] = [];
  }

  const groupsHtml = groups
    .map(
      (g) => `
      <div class="opt-group" data-group="${escapeHtml(g.id)}">
        <h4>${escapeHtml(g.label)}${g.required ? `<span class="req"> · required</span>` : ""}</h4>
        <div class="opt-choices">
          ${(g.choices || [])
            .map(
              (c) => `
            <button type="button" class="opt-choice ${g.multiple ? "multi" : ""}" data-choice="${escapeHtml(c.id)}" data-group="${escapeHtml(g.id)}" data-multi="${g.multiple ? 1 : 0}">
              <span class="opt-radio" aria-hidden="true"></span>
              <span class="opt-info">
                <span class="opt-label">${escapeHtml(c.label)}</span>
                ${c.description ? `<span class="opt-desc">${escapeHtml(c.description)}</span>` : ""}
              </span>
              ${c.price != null && !Number.isNaN(Number(c.price)) ? `<span class="opt-price">+${fmtPrice(business.currency, c.price)}</span>` : ""}
            </button>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");

  const html = `
    <div class="modal-head">
      <div>
        <h3>${escapeHtml(item.name)}</h3>
        ${item.description ? `<p class="modal-sub">${escapeHtml(item.description)}</p>` : ""}
      </div>
      <button class="drawer-close" type="button" data-close-modal aria-label="Close">${icons.close}</button>
    </div>
    ${item.image ? mediaHtml(item) : ""}
    <div class="modal-body">
      ${groupsHtml}
    </div>
    <div class="modal-foot">
      <div style="display:flex;align-items:center;gap:0.6rem">
        <div class="qty-stepper">
          <button type="button" id="opt-minus" aria-label="Decrease quantity">${icons.minus}</button>
          <span class="qty-num" id="opt-qty">1</span>
          <button type="button" id="opt-plus" aria-label="Increase quantity">${icons.plus}</button>
        </div>
        <span class="modal-total" id="opt-total">${fmtPrice(business.currency, unitPrice(item, selection, qty.n))}</span>
      </div>
      <button class="btn btn-primary" type="button" id="opt-add">${icons.cart}<span>Add to order</span></button>
    </div>`;

  openModal(html);

  const card = document.getElementById("modal-card");

  card.querySelectorAll(".opt-choice").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gid = btn.dataset.group;
      const cid = btn.dataset.choice;
      const isMulti = btn.dataset.multi === "1";
      if (isMulti) {
        const arr = selection[gid] || [];
        const idx = arr.indexOf(cid);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(cid);
        selection[gid] = arr;
      } else {
        selection[gid] = cid;
        card.querySelectorAll(`[data-group="${CSS.escape(gid)}"] .opt-choice`).forEach((b) => b.classList.remove("selected"));
      }
      btn.classList.toggle("selected");
      updateTotal();
    });
  });

  const syncSelectionUI = () => {
    card.querySelectorAll(".opt-choice").forEach((btn) => {
      const gid = btn.dataset.group;
      const cid = btn.dataset.choice;
      const isMulti = btn.dataset.multi === "1";
      const sel = selection[gid];
      const active = isMulti ? (sel || []).includes(cid) : sel === cid;
      btn.classList.toggle("selected", active);
    });
    updateTotal();
  };

  const updateTotal = () => {
    const el = card.querySelector("#opt-total");
    if (el) el.textContent = fmtPrice(business.currency, unitPrice(item, selection, qty.n));
    const q = card.querySelector("#opt-qty");
    if (q) q.textContent = qty.n;
  };

  card.querySelector("#opt-minus").addEventListener("click", () => {
    if (qty.n > 1) {
      qty.n -= 1;
      updateTotal();
    }
  });
  card.querySelector("#opt-plus").addEventListener("click", () => {
    if (qty.n < 99) {
      qty.n += 1;
      updateTotal();
    }
  });

  card.querySelector("#opt-add").addEventListener("click", () => {
    const missing = groups.filter((g) => g.required && !g.multiple && !selection[g.id]);
    if (missing.length) {
      toast(`Please choose a ${missing[0].label.toLowerCase()}`);
      return;
    }
    addLine(makeLine(item, selection, qty.n));
    closeModal();
    toast(`Added ${qty.n}× ${item.name} to your order`);
  });

  syncSelectionUI();
}

function unitPrice(item, selection, qtyN) {
  const line = makeLine(item, selection, 1);
  return round2(line.unitPrice * qtyN);
}

/* ------------------------- Cart drawer ------------------------- */

function renderCart() {
  const body = els.drawerBody;
  const lines = cart.lines;

  if (!lines.length) {
    body.innerHTML = `
      <div class="cart-empty">
        <div class="icon" style="width:3rem;height:3rem;margin:0 auto 1rem;color:var(--rose)">${icons.cookie}</div>
        <h4>Your order is empty</h4>
        <p>Add something sweet from the menu and it will appear here.</p>
      </div>`;
    els.drawerFoot.hidden = true;
  } else {
    body.innerHTML = lines
      .map((l) => {
        const opts = l.lines.filter((x) => x.kind === "opt").map((x) => x.text).join(" · ");
        const addons = l.lines.filter((x) => x.kind === "addon");
        const thumb = toAbs(l.image);
        return `
          <div class="cart-line">
            <div class="line-thumb">
              ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : icons.cookie}
            </div>
            <div class="line-main">
              <div class="line-name">${escapeHtml(l.name)}${l.catName ? ` <span class="line-cat">${escapeHtml(l.catName)}</span>` : ""}</div>
              ${opts ? `<div class="line-opts">${escapeHtml(opts)}</div>` : ""}
              ${addons.length ? `<div class="line-opts">${addons.map((a) => `<span class="opt-plus">+</span> ${escapeHtml(a.text)} (+${fmtPrice(business.currency, a.price)})`).join("<br>")}</div>` : ""}
              <div style="margin-top:0.45rem">
                <span class="qty-stepper">
                  <button type="button" data-dec="${escapeHtml(l.key)}" aria-label="Decrease">${icons.minus}</button>
                  <span class="qty-num">${l.qty}</span>
                  <button type="button" data-inc="${escapeHtml(l.key)}" aria-label="Increase">${icons.plus}</button>
                </span>
              </div>
            </div>
            <div class="line-side">
              <span class="line-price">${fmtPrice(business.currency, l.unitPrice * l.qty)}</span>
              <button class="line-remove" type="button" data-remove="${escapeHtml(l.key)}" aria-label="Remove ${escapeHtml(l.name)}">${icons.trash}</button>
            </div>
          </div>`;
      })
      .join("");
    els.drawerFoot.hidden = false;
    els.drawerTotal.textContent = fmtPrice(business.currency, cart.subtotal);
    els.drawerHintText.textContent = `We deliver in ${business.delivery || "Beirut – Dahye"} · Order is sent to WhatsApp`;
  }

  body.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => {
    cart.setQty(b.dataset.dec, cart.lines.find((l) => l.key === b.dataset.dec)?.qty - 1);
  }));
  body.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => {
    cart.setQty(b.dataset.inc, cart.lines.find((l) => l.key === b.dataset.inc)?.qty + 1);
  }));
  body.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
    cart.remove(b.dataset.remove);
  }));
}

function openDrawer() {
  drawerOpen = true;
  els.drawer.classList.add("open");
  els.drawer.setAttribute("aria-hidden", "false");
  els.overlay.classList.add("show");
  renderCart();
}

function closeDrawer() {
  drawerOpen = false;
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
  els.overlay.classList.remove("show");
}

/* ------------------------- Checkout → WhatsApp ------------------------- */

function openCheckoutModal() {
  if (cart.isEmpty()) return;

  const lines = cart.lines;
  const cur = business.currency || "$";
  const summary = lines
    .map((l) => {
      const opts = l.lines.filter((x) => x.kind === "opt").map((x) => x.text).join(" / ");
      const addons = l.lines.filter((x) => x.kind === "addon");
      const extra = addons.length ? ` + ${addons.map((a) => a.text).join(" + ")}` : "";
      return `<div class="cs-row"><span>${escapeHtml(l.qty)}× ${escapeHtml(l.name)}${l.catName ? ` <em style="color:var(--ink-muted)">[${escapeHtml(l.catName)}]</em>` : ""}${opts ? ` <em style="color:var(--ink-muted)">(${escapeHtml(opts)}${escapeHtml(extra)})</em>` : ""}</span><span>${fmtPrice(cur, l.unitPrice * l.qty)}</span></div>`;
    })
    .join("");

  const html = `
    <div class="modal-head">
      <div>
        <h3>Almost there!</h3>
        <p class="modal-sub">Send your order to us on WhatsApp — we'll confirm the details.</p>
      </div>
      <button class="drawer-close" type="button" data-close-modal aria-label="Close">${icons.close}</button>
    </div>
    <div class="modal-body">
      <div class="checkout-summary">
        ${summary}
        <div class="cs-row total"><span>Subtotal</span><span>${fmtPrice(cur, cart.subtotal)}</span></div>
      </div>
      <div class="form-field">
        <label for="co-name">Your name *</label>
        <input id="co-name" type="text" placeholder="e.g. Sam" maxlength="60" autocomplete="name" required />
      </div>
      <div class="form-field">
        <label for="co-phone">Phone number *</label>
        <input id="co-phone" type="tel" placeholder="e.g. 03 123 456" maxlength="20" autocomplete="tel" inputmode="tel" required />
      </div>
      <div class="form-field">
        <label for="co-address">Delivery address *</label>
        <textarea id="co-address" rows="2" placeholder="Street, building, floor, area, nearest landmark…" maxlength="300" autocomplete="street-address" required></textarea>
      </div>
      <div class="form-field">
        <label for="co-note">Notes (optional)</label>
        <textarea id="co-note" rows="2" placeholder="Any special requests or pickup time…" maxlength="300"></textarea>
      </div>
    </div>
    <div class="modal-foot" style="justify-content:flex-end">
      <button class="btn btn-primary" type="button" id="co-send">${icons.whatsapp}<span>Send order on WhatsApp</span></button>
    </div>`;

  openModal(html);

  const card = document.getElementById("modal-card");
  const nameInput = card.querySelector("#co-name");
  const phoneInput = card.querySelector("#co-phone");
  const addressInput = card.querySelector("#co-address");
  const noteInput = card.querySelector("#co-note");
  const sendBtn = card.querySelector("#co-send");
  setTimeout(() => nameInput.focus(), 60);

  sendBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const address = addressInput.value.trim();
    const note = noteInput.value.trim();

    if (!name) {
      toast("Please enter your name");
      nameInput.focus();
      return;
    }
    if (!phone) {
      toast("Please enter your phone number");
      phoneInput.focus();
      return;
    }
    if (!address) {
      toast("Please enter your delivery address");
      addressInput.focus();
      return;
    }

    sendBtn.disabled = true;
    await sendOrder({ name, phone, address, note });
  });

  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") sendBtn.click();
  });
}

async function sendOrder({ name, phone, address, note }) {
  const cur = business.currency || "$";

  // Reserve the WhatsApp tab synchronously (inside the click gesture) so popup
  // blockers can't stop it, then point it at the final link once the order
  // number is reserved. With noopener the handle would be null, so omit it and
  // sever the opener link ourselves after navigation.
  const win = window.open("", "_blank");

  const lines = cart.lines
    .map((l) => {
      const opts = l.lines.filter((x) => x.kind === "opt").map((x) => x.text).join(" / ");
      const addons = l.lines.filter((x) => x.kind === "addon");
      const head = `• ${l.qty}× ${l.name}${l.catName ? ` [${l.catName}]` : ""}${opts ? ` (${opts})` : ""} — ${fmtPrice(cur, l.unitPrice * l.qty)}`;
      const extra = addons.map((a) => `   + ${a.text} — ${fmtPrice(cur, a.price)}`).join("\n");
      return extra ? `${head}\n${extra}` : head;
    })
    .join("\n");

  // Reserve the next sequential order number from the worker (starts at 0001).
  // If the worker is unreachable, WhatsApp still opens with a temporary number.
  let orderId = "";
  try {
    const req = api.submitOrder({
      source: "site",
      items: cart.lines.map((l) => ({
        name: l.name,
        qty: l.qty,
        unitPrice: l.unitPrice,
        category: l.catName || "",
        options: l.lines.map((x) => x.text),
      })),
      total: cart.subtotal,
      name: name || "",
      phone: phone || "",
      address: address || "",
      note: note || "",
    });
    req.catch(() => {}); // consume a late rejection so it's never unhandled
    const res = await withTimeout(req, 6000);
    orderId = (res && res.id) || "";
  } catch {
    /* worker unreachable — fall back below */
  }
  if (!orderId) orderId = makeOrderId();

  const msg = [
    `*NEW ORDER — ${business.name || "YUMMY DOLCE"}*`,
    `Order #${orderId}`,
    ``,
    `*ITEMS*`,
    lines,
    ``,
    `*Subtotal: ${fmtPrice(cur, cart.subtotal)}*`,
    ``,
    `*Name:* ${name}`,
    `*Phone:* ${phone}`,
    `*Address:* ${address}`,
    note ? `*Note:* ${note}` : ``,
  ]
    .filter((s) => s !== "")
    .join("\n");

  const link = waLink(business.whatsapp, msg);
  if (win && !win.closed) {
    win.location.href = link;
    win.opener = null; // sever the opener link, like noopener would
  } else {
    window.open(link, "_blank", "noopener");
  }

  closeModal();
  closeDrawer();
  cart.clear();
  toast("Opening WhatsApp… your order is on its way!");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function makeOrderId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const arr = new Uint8Array(5);
  crypto.getRandomValues(arr);
  return [...arr].map((n) => chars[n % chars.length]).join("");
}

/* ------------------------- Wiring ------------------------- */

function syncCartUI() {
  const count = cart.count;
  els.cartBadge.textContent = count;
  els.cartBadge.hidden = count === 0;
  els.cartBarCount.textContent = `${count} item${count === 1 ? "" : "s"}`;
  els.cartBarTotal.textContent = fmtPrice(business.currency, cart.subtotal);
  els.cartBar.classList.toggle("show", count > 0);
  if (drawerOpen) renderCart();
}

function init() {
  initModalControls(els.overlay);

  els.cartBtn.addEventListener("click", openDrawer);
  els.cartBarOpen.addEventListener("click", openDrawer);
  els.cartBar.addEventListener("click", (e) => {
    if (e.target === els.cartBar) openDrawer();
  });
  els.drawerClose.addEventListener("click", closeDrawer);
  els.checkoutBtn.addEventListener("click", openCheckoutModal);

  els.overlay.addEventListener("click", () => {
    if (!isModalOpen()) closeDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !isModalOpen() && drawerOpen) closeDrawer();
  });

  window.addEventListener("scroll", () => {
    els.header.classList.toggle("scrolled", window.scrollY > 8);
  }, { passive: true });

  cart.subscribe(syncCartUI);
  syncCartUI(); // reflect any cart restored from localStorage

  loadMenu();
}

async function loadMenu() {
  els.menuRoot.innerHTML = `<div class="loader" aria-label="Loading menu"><span></span><span></span><span></span></div>`;

  try {
    const data = await api.getMenu();
    business = { ...SITE_DEFAULTS, ...(data.business || {}) };
    categories = (data.categories || []).sort((a, b) => (a.sort || 0) - (b.sort || 0));
    renderBusiness();
    renderMenu();
    syncCartUI(); // re-sync totals with the real currency
  } catch (err) {
    // Keep the site chrome from defaults so the page still looks alive.
    renderBusiness();
    els.menuRoot.innerHTML = `
      <div class="state-box">
        <div class="state-icon">${icons.refresh}</div>
        <h3>We can't reach the menu right now</h3>
        <p>Please check your connection or try again in a moment.</p>
        <button class="btn btn-primary" type="button" id="retry-btn">${icons.refresh}<span>Try again</span></button>
      </div>`;
    els.menuRoot.querySelector("#retry-btn").addEventListener("click", loadMenu);
    console.error("Failed to load menu:", err);
  }
}

init();
