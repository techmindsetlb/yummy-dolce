/**
 * YUMMY DOLCE — admin panel.
 *
 * Passcode-protected management of the online menu. All data lives in the
 * Cloudflare Worker (KV) — this panel is just an editor. The auth token
 * is kept only in memory, so nothing sensitive ever touches localStorage.
 */
import { SEED_MENU_URL, SITE_DEFAULTS, toAbs, waLink } from "./config.js";
import { icons } from "./icons.js";
import * as api from "./api.js";
import {
  escapeHtml,
  fmtPrice,
  toast,
  openModal,
  closeModal,
  initModalControls,
  observeReveals,
  uid,
} from "./ui.js";
import { compressImageToWebp, formatBytes } from "./image-utils.js";

const $ = (id) => document.getElementById(id);

const state = {
  menu: null, // working copy: { business, categories }
  dirty: false,
  saving: false,
  orders: [],
};

/* ------------------------- Stored-image cleanup ------------------------- */

/** Extract the storage key from an image URL (`/api/images/img/xxx.webp` → `img/xxx.webp`). */
function imgKeyOf(url) {
  return url && url.startsWith("/api/images/") ? decodeURIComponent(url.slice("/api/images/".length)) : null;
}

/** Best-effort delete of an image that is no longer referenced by the menu. */
function discardStoredImage(url) {
  const key = imgKeyOf(url);
  if (key) api.deleteImage(key).catch(() => {});
}

/* ============================ Login ============================ */

const loginView = $("login-view");
const adminView = $("admin-view");

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  const errEl = $("login-error");
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "Checking…";

  const passcode = $("passcode").value.trim();
  try {
    const res = await api.login(passcode);
    api.setToken(res.token);
    enterAdmin();
  } catch (err) {
    errEl.textContent =
      err.status === 0
        ? "Can't reach the server. Check your connection and try again."
        : err.status === 429
          ? "Too many attempts. Please wait a few minutes and try again."
          : "Incorrect passcode. Please try again.";
    errEl.hidden = false;
    $("passcode").select();
  } finally {
    btn.disabled = false;
    btn.textContent = "Unlock panel";
  }
});

$("logout-btn").addEventListener("click", () => {
  api.setToken(null);
  location.reload();
});

function enterAdmin() {
  loginView.hidden = true;
  adminView.hidden = false;
  initModalControls(null);
  observeReveals(document);
  loadAll();
}

/* ============================ Loading ============================ */

async function loadAll() {
  $("menu-pane").innerHTML = `<div class="loader"><span></span><span></span><span></span></div>`;
  try {
    const data = await api.getMenu();
    state.menu = {
      business: { ...SITE_DEFAULTS, ...(data.business || {}) },
      categories: (data.categories || []).map(normalizeCategory),
    };
  } catch (err) {
    state.menu = {
      business: { ...SITE_DEFAULTS },
      categories: [],
    };
    toast("Could not load the menu from the server", { duration: 4000 });
  }
  renderMenuPane();
  fillBusinessForm();
  renderOrders();
}

function normalizeCategory(cat) {
  return {
    ...cat,
    sort: cat.sort ?? 0,
    items: (cat.items || []).map((it, i) => ({
      ...it,
      sort: it.sort ?? i + 1,
      optionGroups: (it.optionGroups || []).map((g) => ({ ...g, choices: g.choices || [] })),
    })),
  };
}

function markDirty() {
  state.dirty = true;
  $("save-btn").disabled = false;
  $("save-state").hidden = false;
}

function clearDirty() {
  state.dirty = false;
  $("save-btn").disabled = true;
  $("save-state").hidden = true;
}

/* ============================ Tabs ============================ */

const tabTitles = { menu: "Menu", orders: "Orders", settings: "Settings" };

function switchTab(tab) {
  document.querySelectorAll(".admin-nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  ["menu", "orders", "settings"].forEach((t) => {
    $("tab-" + t).hidden = t !== tab;
  });
  $("tab-title").textContent = tabTitles[tab];
  if (tab === "orders") renderOrders();
}

document.querySelectorAll(".admin-nav-item[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => switchTab(btn.dataset.tab))
);

$("save-btn").addEventListener("click", saveChanges);

async function saveChanges() {
  if (!state.menu || state.saving) return;
  state.saving = true;
  const btn = $("save-btn");
  btn.disabled = true;
  btn.innerHTML = `${icons.refresh} Saving…`;
  try {
    const payload = {
      ...state.menu,
      updatedAt: new Date().toISOString(),
    };
    await api.saveMenu(payload);
    state.menu = payload;
    clearDirty();
    toast("Saved! The menu is updated for everyone.");
  } catch (err) {
    toast(err.message || "Save failed — please try again.", { duration: 4000 });
    markDirty();
  } finally {
    state.saving = false;
    btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg> Save changes`;
    if (state.dirty) btn.disabled = false;
  }
}

/* ============================ Menu pane ============================ */

function renderMenuPane() {
  const pane = $("menu-pane");
  const cats = state.menu.categories;

  if (!cats.length) {
    pane.innerHTML = `
      <div class="menu-empty">
        <h3>No menu yet</h3>
        <p>Start from the sample menu we built from your printed menu, or add categories from scratch.</p>
        <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="load-sample" type="button">${icons.box}<span>Load sample menu</span></button>
          <button class="btn btn-secondary" id="add-cat" type="button">${icons.plus}<span>Add a category</span></button>
        </div>
      </div>`;
    pane.querySelector("#load-sample").addEventListener("click", loadSampleMenu);
    pane.querySelector("#add-cat").addEventListener("click", () => openCategoryEditor(null));
    return;
  }

  const sorted = [...cats].sort((a, b) => (a.sort || 0) - (b.sort || 0));
  pane.innerHTML = sorted
    .map((cat, idx) => {
      const items = [...cat.items].sort((a, b) => (a.sort || 0) - (b.sort || 0));
      return `
        <div class="category-block" data-cat="${escapeHtml(cat.id)}">
          <div class="category-block-head">
            <span class="icon cat-chevron">${icons.menu}</span>
            <div class="cat-title">
              <strong>${escapeHtml(cat.name)}</strong>
              ${cat.subtitle ? `<span>${escapeHtml(cat.subtitle)}</span>` : ""}
            </div>
            <span class="cat-count">${items.length} item${items.length === 1 ? "" : "s"}</span>
            <div class="cat-actions">
              <button class="icon-btn" data-act="up" title="Move up" aria-label="Move up">${arrowUp()}</button>
              <button class="icon-btn" data-act="down" title="Move down" aria-label="Move down">${arrowDown()}</button>
              <button class="icon-btn" data-act="edit" title="Edit category" aria-label="Edit category">${icons.edit}</button>
              <button class="icon-btn danger" data-act="del" title="Delete category" aria-label="Delete category">${icons.trash}</button>
            </div>
          </div>
          <div class="category-block-body">
            ${items
              .map((it, iidx) => {
                const priceLabel = adminPriceLabel(it);
                return `
                  <div class="admin-item-row" data-item="${escapeHtml(it.id)}">
                    <div class="admin-item-thumb">
                      ${it.image ? `<img src="${escapeHtml(toAbs(it.image))}" alt="" loading="lazy" />` : icons.cookie}
                    </div>
                    <div class="admin-item-main">
                      <strong>${escapeHtml(it.name)}</strong>
                      <span>${escapeHtml(itemSummary(it))}</span>
                    </div>
                    <span class="admin-item-price">${priceLabel}</span>
                    <div class="admin-item-actions">
                      <button class="icon-btn" data-act="up" title="Move up" aria-label="Move up">${arrowUp()}</button>
                      <button class="icon-btn" data-act="down" title="Move down" aria-label="Move down">${arrowDown()}</button>
                      <button class="icon-btn" data-act="edit" title="Edit item" aria-label="Edit item">${icons.edit}</button>
                      <button class="icon-btn danger" data-act="del" title="Delete item" aria-label="Delete item">${icons.trash}</button>
                    </div>
                  </div>`;
              })
              .join("")}
            <button class="add-row-btn" data-act="add-item" data-cat="${escapeHtml(cat.id)}" type="button">${icons.plus}<span>Add item</span></button>
          </div>
        </div>`;
    })
    .join("");

  pane.querySelectorAll(".category-block-head").forEach((head) =>
    head.addEventListener("click", (e) => {
      if (e.target.closest(".cat-actions")) return;
      head.parentElement.classList.toggle("open");
    })
  );

  pane.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const block = btn.closest(".category-block");
      const catId = block.dataset.cat;
      const act = btn.dataset.act;

      // Item-row buttons first: edit/delete/reorder must target the item,
      // not the category (they share the same data-act labels as the category ones).
      const itemEl = btn.closest("[data-item]");
      if (itemEl) {
        const cat = state.menu.categories.find((c) => c.id === catId);
        const itemId = itemEl.dataset.item;
        if (act === "edit") return openItemEditor(catId, cat?.items.find((i) => i.id === itemId));
        if (act === "del") return deleteItem(catId, itemId);
        if (act === "up" || act === "down") return moveItem(catId, itemId, act);
        return;
      }

      // Otherwise it's a category-level action.
      if (act === "add-item") return openItemEditor(catId, null);
      if (act === "edit") return openCategoryEditor(catId);
      if (act === "del") return deleteCategory(catId);
      if (act === "up" || act === "down") return moveCategory(catId, act);
    });
  });
}

function arrowUp() {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>`;
}

function arrowDown() {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}

function itemSummary(item) {
  const parts = [];
  if (item.description) parts.push(item.description);
  const groups = (item.optionGroups || [])
    .map((g) => `${g.choices.length} ${g.label.toLowerCase()} options`)
    .join(", ");
  if (groups) parts.push(groups);
  return parts.join(" · ") || "—";
}

function adminPriceLabel(item) {
  if (item.price != null && item.price !== "" && !Number.isNaN(Number(item.price))) {
    return fmtPrice(state.menu.business.currency, item.price);
  }
  const hasPriced = (item.optionGroups || []).some((g) => (g.choices || []).some((c) => c.price != null && !Number.isNaN(Number(c.price))));
  if (hasPriced) {
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
    return any ? `from ${fmtPrice(state.menu.business.currency, total)}` : "—";
  }
  return "—";
}

/* ---------- Sample menu ---------- */

async function loadSampleMenu() {
  try {
    const res = await fetch(SEED_MENU_URL);
    if (!res.ok) throw new Error("bad status");
    const seed = await res.json();
    state.menu = {
      business: { ...SITE_DEFAULTS, ...(seed.business || {}) },
      categories: (seed.categories || []).map(normalizeCategory),
    };
    renderMenuPane();
    fillBusinessForm();
    markDirty();
    toast("Sample menu loaded — review it, then press Save changes.");
  } catch {
    toast("Couldn't load the sample menu file. Check that data/seed-menu.json exists.", { duration: 4000 });
  }
}

/* ---------- Category CRUD ---------- */

function nextSort(list) {
  return list.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
}

function openCategoryEditor(catId) {
  const cat = catId ? state.menu.categories.find((c) => c.id === catId) : null;
  const html = `
    <div class="modal-head">
      <div>
        <h3>${cat ? "Edit category" : "New category"}</h3>
        <p class="modal-sub">Categories appear as numbered sections on the menu site.</p>
      </div>
      <button class="modal-close" type="button" data-close-modal aria-label="Close">${icons.close}</button>
    </div>
    <div class="editor-scroll">
      <div class="form-field">
        <label for="cat-name">Category name *</label>
        <input id="cat-name" class="admin-input" type="text" maxlength="40" value="${escapeHtml(cat?.name || "")}" placeholder="e.g. Cookies" />
      </div>
      <div class="form-field">
        <label for="cat-sub">Subtitle (optional)</label>
        <input id="cat-sub" class="admin-input" type="text" maxlength="80" value="${escapeHtml(cat?.subtitle || "")}" placeholder="e.g. 135 g · baked fresh" />
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-primary" type="button" id="cat-save">${icons.check}<span>${cat ? "Save category" : "Add category"}</span></button>
    </div>`;

  openModal(html);
  const card = $("modal-card");
  $("cat-name").focus();

  card.querySelector("#cat-save").addEventListener("click", () => {
    const name = $("cat-name").value.trim();
    if (!name) {
      toast("Please give the category a name");
      return;
    }
    const subtitle = $("cat-sub").value.trim();
    if (cat) {
      cat.name = name;
      cat.subtitle = subtitle;
    } else {
      state.menu.categories.push({ id: uid("cat-"), name, subtitle, sort: nextSort(state.menu.categories), items: [] });
    }
    markDirty();
    closeModal();
    renderMenuPane();
    toast(cat ? "Category updated" : "Category added");
  });
}

function deleteCategory(catId) {
  const cat = state.menu.categories.find((c) => c.id === catId);
  if (!cat) return;
  confirmDialog("Delete this category?", `"${cat.name}" and its ${cat.items.length} item(s) will be removed from the menu.`, "Delete category").then((ok) => {
    if (!ok) return;
    for (const it of cat.items) if (it.image) discardStoredImage(it.image);
    state.menu.categories = state.menu.categories.filter((c) => c.id !== catId);
    markDirty();
    renderMenuPane();
    toast("Category deleted");
  });
}

function moveCategory(catId, dir) {
  const sorted = [...state.menu.categories].sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const idx = sorted.findIndex((c) => c.id === catId);
  const swap = dir === "up" ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= sorted.length) return;
  [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
  sorted.forEach((c, i) => (c.sort = i + 1));
  markDirty();
  renderMenuPane();
}

/* ---------- Item CRUD ---------- */

function moveItem(catId, itemId, dir) {
  const cat = state.menu.categories.find((c) => c.id === catId);
  if (!cat) return;
  const sorted = [...cat.items].sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const idx = sorted.findIndex((i) => i.id === itemId);
  const swap = dir === "up" ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= sorted.length) return;
  [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
  sorted.forEach((i, n) => (i.sort = n + 1));
  markDirty();
  renderMenuPane();
}

function deleteItem(catId, itemId) {
  const cat = state.menu.categories.find((c) => c.id === catId);
  if (!cat) return;
  const item = cat.items.find((i) => i.id === itemId);
  confirmDialog("Delete this item?", `"${item.name}" will be removed from the menu.`, "Delete item").then((ok) => {
    if (!ok) return;
    if (item.image) discardStoredImage(item.image);
    cat.items = cat.items.filter((i) => i.id !== itemId);
    markDirty();
    renderMenuPane();
    toast("Item deleted");
  });
}

/* ---------- Item editor ---------- */

function openItemEditor(catId, item) {
  const cat = state.menu.categories.find((c) => c.id === catId);
  if (!cat) return;

  const draft = item
    ? JSON.parse(JSON.stringify(item))
    : { id: uid("it-"), name: "", description: "", price: null, image: null, sort: nextSort(cat.items), optionGroups: [] };

  const pending = { blob: null, size: null };

  const groupsModel = (draft.optionGroups || []).map((g) => ({
    id: g.id || uid("g-"),
    label: g.label || "",
    required: !!g.required,
    multiple: !!g.multiple,
    choices: (g.choices || []).map((c) => ({
      id: c.id || uid("c-"),
      label: c.label || "",
      price: c.price ?? null,
      description: c.description || "",
    })),
  }));

  const html = `
    <div class="modal-head">
      <div>
        <h3>${item ? "Edit item" : "New item"}</h3>
        <p class="modal-sub">in ${escapeHtml(cat.name)}</p>
      </div>
      <button class="modal-close" type="button" data-close-modal aria-label="Close">${icons.close}</button>
    </div>
    <div class="editor-scroll">
      <section class="editor-section">
        <h3>Details</h3>
        <div class="form-field">
          <label for="ed-name">Item name *</label>
          <input id="ed-name" class="admin-input" type="text" maxlength="60" value="${escapeHtml(draft.name)}" placeholder="e.g. Biscoff Dream" />
        </div>
        <div class="form-field">
          <label for="ed-desc">Description</label>
          <textarea id="ed-desc" class="admin-input" rows="2" maxlength="240" placeholder="e.g. With biscuit crunch & spread filling">${escapeHtml(draft.description || "")}</textarea>
        </div>
        <div class="form-row">
          <div class="form-field">
            <label for="ed-price">Price (optional — leave empty if options set the price)</label>
            <input id="ed-price" class="admin-input" type="number" step="0.1" min="0" value="${draft.price ?? ""}" placeholder="e.g. 4.5" />
          </div>
        </div>
      </section>

      <section class="editor-section">
        <h3>Photo</h3>
        <div class="photo-editor">
          <div class="photo-preview" id="ed-preview"></div>
          <div class="photo-controls">
            <button class="btn btn-secondary btn-sm" type="button" id="ed-upload">${icons.upload}<span>Choose photo</span></button>
            <input type="file" id="ed-file" accept="image/*" hidden />
            <span class="photo-hint">Photos are automatically compressed and converted to WebP (max 1400 px) right in your browser.</span>
            <div id="ed-pending"></div>
            <button class="btn btn-danger btn-sm" type="button" id="ed-remove-photo" hidden>${icons.trash}<span>Remove photo</span></button>
          </div>
        </div>
      </section>

      <section class="editor-section">
        <h3>Options — sizes, flavors, extras</h3>
        <div id="ed-groups"></div>
        <button class="add-row-btn" type="button" id="ed-add-group">${icons.plus}<span>Add option group</span></button>
      </section>
    </div>
    <div class="modal-foot">
      <button class="btn btn-primary" type="button" id="ed-save">${icons.check}<span>Save item</span></button>
    </div>`;

  openModal(html);
  const card = $("modal-card");

  const previewEl = $("ed-preview");
  const pendingEl = $("ed-pending");
  const removePhotoBtn = $("ed-remove-photo");
  const groupsEl = $("ed-groups");

  const renderPreview = () => {
    if (pending.blob) {
      previewEl.innerHTML = `<img src="${URL.createObjectURL(pending.blob)}" alt="Preview" />`;
      pendingEl.innerHTML = `<div class="photo-pending">${icons.check} Compressed to WebP — ${formatBytes(pending.size)} (from ${formatBytes(draft.originalSize || 0)})</div>`;
      removePhotoBtn.hidden = false;
    } else if (draft.image) {
      previewEl.innerHTML = `<img src="${escapeHtml(toAbs(draft.image))}" alt="Preview" />`;
      pendingEl.innerHTML = "";
      removePhotoBtn.hidden = false;
    } else {
      previewEl.innerHTML = icons.cookie;
      pendingEl.innerHTML = "";
      removePhotoBtn.hidden = true;
    }
  };

  const renderGroups = () => {
    groupsEl.innerHTML = groupsModel
      .map(
        (g, gi) => `
        <div class="group-editor" data-gi="${gi}">
          <div class="group-editor-head">
            <input class="admin-input" type="text" data-field="label" value="${escapeHtml(g.label)}" placeholder="Group label — e.g. Size, Flavor" maxlength="30" />
            <button class="icon-btn danger" type="button" data-del-group aria-label="Remove group">${icons.trash}</button>
          </div>
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" data-field="required" ${g.required ? "checked" : ""} /> Required</label>
            <label class="toggle"><input type="checkbox" data-field="multiple" ${g.multiple ? "checked" : ""} /> Pick multiple</label>
          </div>
          <div>
            ${g.choices
              .map(
                (c, ci) => `
                <div class="choice-row" data-ci="${ci}" style="margin-bottom:0.5rem">
                  <input class="admin-input" type="text" data-field="label" value="${escapeHtml(c.label)}" placeholder="e.g. Medium · 3 pcs" maxlength="40" />
                  <input class="admin-input" type="number" step="0.1" min="0" data-field="price" value="${c.price ?? ""}" placeholder="Price" />
                  <input class="admin-input choice-desc" type="text" data-field="description" value="${escapeHtml(c.description)}" placeholder="Optional note" maxlength="60" />
                  <button class="icon-btn danger" type="button" data-del-choice aria-label="Remove choice">${icons.trash}</button>
                </div>`
              )
              .join("")}
          </div>
          <button class="add-row-btn" type="button" data-add-choice>${icons.plus}<span>Add choice</span></button>
        </div>`
      )
      .join("");
  };

  groupsEl.addEventListener("input", (e) => {
    const gEl = e.target.closest("[data-gi]");
    const cEl = e.target.closest("[data-ci]");
    if (!gEl) return;
    const g = groupsModel[+gEl.dataset.gi];
    if (!g) return;
    const field = e.target.dataset.field;
    if (cEl) {
      const c = g.choices[+cEl.dataset.ci];
      if (c) {
        if (field === "price") c.price = e.target.value === "" ? null : Number(e.target.value);
        else c[field] = e.target.value;
      }
    } else if (field) {
      if (field === "required" || field === "multiple") g[field] = e.target.checked;
      else g[field] = e.target.value;
    }
  });

  groupsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del-group], [data-add-choice], [data-del-choice]");
    if (!btn) return;
    const gEl = btn.closest("[data-gi]");
    const gi = gEl ? +gEl.dataset.gi : groupsModel.length;

    if (btn.dataset.delGroup) {
      groupsModel.splice(gi, 1);
    } else if (btn.dataset.addChoice) {
      groupsModel[gi].choices.push({ id: uid("c-"), label: "", price: null, description: "" });
    } else if (btn.dataset.delChoice) {
      groupsModel[gi].choices.splice(+btn.closest("[data-ci]").dataset.ci, 1);
    }
    renderGroups();
  });

  $("ed-add-group").addEventListener("click", () => {
    groupsModel.push({ id: uid("g-"), label: "", required: true, multiple: false, choices: [{ id: uid("c-"), label: "", price: null, description: "" }] });
    renderGroups();
  });

  $("ed-upload").addEventListener("click", () => $("ed-file").click());
  $("ed-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const result = await compressImageToWebp(file);
      pending.blob = result.blob;
      pending.size = result.compressedBytes;
      draft.originalSize = result.originalBytes;
      renderPreview();
      toast("Photo compressed and ready to upload on save.");
    } catch (err) {
      toast(err.message || "Could not process that image.", { duration: 4000 });
    }
    e.target.value = "";
  });

  removePhotoBtn.addEventListener("click", () => {
    if (draft.image) discardStoredImage(draft.image);
    pending.blob = null;
    pending.size = null;
    draft.image = null;
    renderPreview();
  });

  $("ed-save").addEventListener("click", async () => {
    const name = $("ed-name").value.trim();
    if (!name) {
      toast("Please give the item a name");
      return;
    }

    const btn = $("ed-save");
    btn.disabled = true;

    try {
      // Upload pending photo first (compressed WebP), then drop the old one
      if (pending.blob) {
        const oldImage = draft.image;
        btn.innerHTML = `${icons.refresh} Uploading photo…`;
        const up = await api.uploadImage(pending.blob, `${name}.webp`);
        draft.image = up.url;
        pending.blob = null;
        if (oldImage) discardStoredImage(oldImage);
      }

      const cleanedGroups = groupsModel
        .filter((g) => g.label.trim())
        .map((g) => ({
          id: g.id,
          label: g.label.trim(),
          required: !!g.required,
          multiple: !!g.multiple,
          choices: g.choices
            .filter((c) => c.label.trim())
            .map((c) => ({
              id: c.id,
              label: c.label.trim(),
              price: c.price === null || c.price === "" ? null : Number(c.price),
              description: (c.description || "").trim(),
            })),
        }));

      draft.name = name;
      draft.description = $("ed-desc").value.trim();
      const priceVal = $("ed-price").value;
      draft.price = priceVal === "" ? null : Number(priceVal);
      draft.image = draft.image || null;
      draft.optionGroups = cleanedGroups;

      const idx = cat.items.findIndex((i) => i.id === draft.id);
      if (idx >= 0) cat.items[idx] = draft;
      else cat.items.push(draft);

      markDirty();
      closeModal();
      renderMenuPane();
      toast("Item saved — press Save changes to publish.");
    } catch (err) {
      toast(err.message || "Could not save the item.", { duration: 4000 });
      btn.disabled = false;
      btn.innerHTML = `${icons.check}<span>Save item</span>`;
    }
  });

  renderPreview();
  renderGroups();
  setTimeout(() => $("ed-name").focus(), 60);
}

/* ============================ Orders ============================ */

async function renderOrders() {
  const pane = $("orders-pane");
  try {
    const orders = await api.getOrders();
    state.orders = orders;
    renderOrdersList();
  } catch (err) {
    pane.innerHTML = `
      <div class="orders-empty">
        <div class="icon">${icons.box}</div>
        <h3>Couldn't load orders</h3>
        <p style="margin-top:0.5rem">${escapeHtml(err.message || "Check your connection and try again.")}</p>
      </div>`;
  }
}

function renderOrdersList() {
  const pane = $("orders-pane");
  const orders = state.orders;

  const badge = $("orders-badge");
  const newCount = orders.filter((o) => o.status === "new").length;
  badge.hidden = newCount === 0;
  badge.textContent = newCount;

  if (!orders.length) {
    pane.innerHTML = `
      <div class="orders-empty">
        <div class="icon">${icons.box}</div>
        <h3>No orders yet</h3>
        <p style="margin-top:0.5rem">When a customer checks out on WhatsApp, their order is logged here automatically.</p>
      </div>`;
    return;
  }

  const cur = state.menu.business.currency || "$";
  pane.innerHTML = `<div class="orders-list">
    ${orders
      .map((o) => {
        const itemsHtml = (o.items || [])
          .map((it) => {
            const opts = (it.options || []).length ? ` <em style="color:var(--ink-muted)">(${escapeHtml(it.options.join(" / "))})</em>` : "";
            return `<div class="oi-row"><span>${escapeHtml(it.qty)}× ${escapeHtml(it.name)}${opts}</span><span>${fmtPrice(cur, (Number(it.unitPrice) || 0) * Number(it.qty || 1))}</span></div>`;
          })
          .join("");
        return `
        <div class="order-card">
          <div class="order-card-head">
            <span class="order-id">#${escapeHtml(o.id || "—")}</span>
            <span class="order-time">${formatOrderTime(o.createdAt)}</span>
            <span class="status-badge ${escapeHtml(o.status || "new")}">${escapeHtml((o.status || "new").toUpperCase())}</span>
          </div>
          <div class="order-items">
            ${itemsHtml}
            <div class="oi-row total"><span>Total</span><span>${fmtPrice(cur, Number(o.total) || 0)}</span></div>
          </div>
          <div class="order-meta">
            ${o.name ? `<span><strong>Name:</strong> ${escapeHtml(o.name)}</span>` : ""}
            ${o.phone ? `<span><strong>Phone:</strong> ${escapeHtml(o.phone)}</span>` : ""}
            ${o.address ? `<span><strong>Address:</strong> ${escapeHtml(o.address)}</span>` : ""}
            ${o.note ? `<span><strong>Note:</strong> ${escapeHtml(o.note)}</span>` : ""}
            <span><strong>Source:</strong> WhatsApp</span>
          </div>
          <div class="order-foot">
            <select class="order-status" data-id="${escapeHtml(o.id)}" aria-label="Order status">
              ${["new", "contacted", "done"]
                .map((s) => `<option value="${s}" ${s === (o.status || "new") ? "selected" : ""}>${cap(s)}</option>`)
                .join("")}
            </select>
            <a href="${waLink(state.menu.business.whatsapp, `Hi! I'm following up on order #${o.id || ""}`)}" target="_blank" rel="noopener">${icons.whatsapp} Reply on WhatsApp</a>
          </div>
        </div>`;
      })
      .join("")}
  </div>`;

  pane.querySelectorAll(".order-status").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const id = sel.dataset.id;
      const next = sel.value;
      const prev = state.orders.find((o) => o.id === id)?.status;
      try {
        await api.updateOrderStatus(id, next);
        const o = state.orders.find((x) => x.id === id);
        if (o) o.status = next;
        renderOrdersList();
        toast(`Order #${id} marked as ${next}`);
      } catch (err) {
        sel.value = prev || "new";
        toast(err.message || "Could not update the status.", { duration: 4000 });
      }
    });
  });
}

function formatOrderTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

$("refresh-orders").addEventListener("click", renderOrders);

/* ============================ Settings ============================ */

function fillBusinessForm() {
  const b = state.menu.business;
  $("set-name").value = b.name || "";
  $("set-tagline").value = b.tagline || "";
  $("set-about").value = b.about || "";
  $("set-whatsapp").value = b.whatsapp || "";
  $("set-currency").value = b.currency || "$";
  $("set-delivery").value = b.delivery || "";
  $("set-hours").value = b.hours || "";
  $("set-orderprefix").value = b.orderPrefix || "YD";
  $("set-instagram").value = b.instagram || "";
  $("set-tiktok").value = b.tiktok || "";
  $("set-facebook").value = b.facebook || "";
}

$("business-save").addEventListener("click", async () => {
  const b = state.menu.business;
  b.name = $("set-name").value.trim() || SITE_DEFAULTS.name;
  b.tagline = $("set-tagline").value.trim();
  b.about = $("set-about").value.trim();
  b.whatsapp = $("set-whatsapp").value.replace(/[^0-9]/g, "");
  b.currency = $("set-currency").value.trim() || "$";
  b.delivery = $("set-delivery").value.trim();
  b.hours = $("set-hours").value.trim();
  b.orderPrefix = $("set-orderprefix").value.trim() || "YD";
  b.instagram = $("set-instagram").value.trim();
  b.tiktok = $("set-tiktok").value.trim();
  b.facebook = $("set-facebook").value.trim();

  const btn = $("business-save");
  btn.disabled = true;
  try {
    await api.saveMenu({ ...state.menu, updatedAt: new Date().toISOString() });
    toast("Business details saved and live on the site.");
  } catch (err) {
    toast(err.message || "Could not save business details.", { duration: 4000 });
  } finally {
    btn.disabled = false;
  }
});

$("passcode-save").addEventListener("click", async () => {
  const current = $("pw-current").value;
  const next = $("pw-new").value;
  const confirm = $("pw-confirm").value;

  if (next.length < 6) {
    toast("New passcode must be at least 6 characters.");
    return;
  }
  if (next !== confirm) {
    toast("The two new passcodes don't match.");
    return;
  }

  const btn = $("passcode-save");
  btn.disabled = true;
  try {
    await api.changePasscode(current, next);
    toast("Passcode updated. Use it next time you log in.");
    $("pw-current").value = "";
    $("pw-new").value = "";
    $("pw-confirm").value = "";
  } catch (err) {
    toast(err.message || "Could not update the passcode.", { duration: 4000 });
  } finally {
    btn.disabled = false;
  }
});

/* ============================ Confirm dialog ============================ */

function confirmDialog(title, text, confirmText) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => {
      if (!resolved) {
        resolved = true;
        resolve(v);
      }
    };
    const html = `
      <div class="confirm-card">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
        <div class="confirm-actions">
          <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-danger" type="button" id="confirm-yes">${escapeHtml(confirmText || "Delete")}</button>
        </div>
      </div>`;
    openModal(html, () => done(false));
    $("modal-card").querySelector("#confirm-yes").addEventListener("click", () => {
      done(true);
      closeModal();
    });
  });
}

/* ============================ Boot ============================ */

observeReveals(document);
