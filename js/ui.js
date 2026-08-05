/** Shared UI helpers used by both the customer site and the admin panel. */

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtPrice(currency, n) {
  const num = Number(n);
  if (Number.isNaN(num)) return `${currency || "$"}0.00`;
  const fixed = num % 1 === 0 ? num.toFixed(0) : num.toFixed(2);
  return `${currency || "$"}${fixed}`;
}

export function fmtNumber(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return "0";
  return num % 1 === 0 ? String(num) : num.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function uid(prefix = "") {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7)
  );
}

/* ------------------------- Toasts ------------------------- */

let toastRoot = null;

export function toast(message, opts = {}) {
  if (!toastRoot) toastRoot = document.getElementById("toast-root");
  if (!toastRoot) return;

  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
    <span></span>`;
  el.querySelector("span").textContent = message;
  toastRoot.appendChild(el);

  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 320);
  }, opts.duration || 2600);
}

/* ------------------------- Modal ------------------------- */

let modalEl = null;
let modalCard = null;
let modalOnClose = null;

export function openModal(html, onClose) {
  if (!modalEl) modalEl = document.getElementById("modal");
  if (!modalCard) modalCard = document.getElementById("modal-card");
  if (!modalEl) return null;

  modalCard.innerHTML = html;
  modalEl.classList.add("show");
  modalEl.setAttribute("aria-hidden", "false");
  modalOnClose = onClose || null;

  const close = () => closeModal();
  modalEl.querySelectorAll("[data-close-modal]").forEach((b) => b.addEventListener("click", close));
  return modalCard;
}

export function closeModal() {
  if (!modalEl) return;
  modalEl.classList.remove("show");
  modalEl.setAttribute("aria-hidden", "true");
  if (modalOnClose) {
    const fn = modalOnClose;
    modalOnClose = null;
    fn();
  }
}

export function isModalOpen() {
  return !!(modalEl && modalEl.classList.contains("show"));
}

/** Escape closes the modal; click on the backdrop closes it too. */
export function initModalControls(overlayEl) {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isModalOpen()) closeModal();
    if (e.key === "Escape" && overlayEl && overlayEl.classList.contains("show")) {
      window.dispatchEvent(new CustomEvent("overlay:close"));
    }
  });
  if (modalEl) {
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) closeModal();
    });
  }
}

/* ------------------------- Scroll reveal ------------------------- */

let revealObserver = null;

export function observeReveals(root = document) {
  if (!("IntersectionObserver" in window)) {
    root.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            revealObserver.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
  }
  root.querySelectorAll("[data-reveal]").forEach((el) => revealObserver.observe(el));
}
