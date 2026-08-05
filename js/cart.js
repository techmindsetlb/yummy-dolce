/**
 * Cart.
 *
 * Persisted to localStorage so an order survives page reloads and accidental
 * tab closes (the owner asked for this). It's cleared once the order is sent
 * on WhatsApp. The menu itself is never stored locally — it's always fetched
 * live from the API.
 */
const STORAGE_KEY = "yummy-dolce-cart";

class Cart {
  constructor() {
    /** @type {Map<string, import("./cart").CartLine>} */
    this._lines = new Map();
    this._hydrate();
  }

  _hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return;
      for (const line of saved) {
        if (
          line &&
          line.key &&
          line.qty > 0 &&
          typeof line.name === "string" &&
          typeof line.unitPrice === "number"
        ) {
          this._lines.set(line.key, line);
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.lines));
    } catch {
      /* ignore (private mode / quota) */
    }
  }

  /** Add a line or merge into an existing one. */
  add(line) {
    const key = line.key;
    const existing = this._lines.get(key);
    if (existing) {
      existing.qty += line.qty;
    } else {
      this._lines.set(key, { ...line });
    }
    this._emit();
  }

  setQty(key, qty) {
    const line = this._lines.get(key);
    if (!line) return;
    if (qty <= 0) {
      this._lines.delete(key);
    } else {
      line.qty = Math.min(qty, 99);
    }
    this._emit();
  }

  remove(key) {
    this._lines.delete(key);
    this._emit();
  }

  clear() {
    this._lines.clear();
    this._emit();
  }

  get lines() {
    return [...this._lines.values()];
  }

  get count() {
    return this.lines.reduce((n, l) => n + l.qty, 0);
  }

  get subtotal() {
    return round2(this.lines.reduce((n, l) => n + l.qty * l.unitPrice, 0));
  }

  isEmpty() {
    return this._lines.size === 0;
  }

  /** Subscribe to changes. Returns an unsubscribe fn. */
  subscribe(fn) {
    const handler = () => fn(this);
    window.addEventListener("cart:change", handler);
    return () => window.removeEventListener("cart:change", handler);
  }

  _emit() {
    this._persist();
    window.dispatchEvent(new CustomEvent("cart:change", { detail: this }));
  }
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export const cart = new Cart();
