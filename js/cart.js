/**
 * In-memory cart.
 *
 * Deliberately NOT persisted anywhere — the user asked for no local storage.
 * The menu data is always fetched live from the API; the cart lives only for
 * the current session and resets on refresh.
 */
class Cart {
  constructor() {
    /** @type {Map<string, import("./cart").CartLine>} */
    this._lines = new Map();
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
    window.dispatchEvent(new CustomEvent("cart:change", { detail: this }));
  }
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export const cart = new Cart();
