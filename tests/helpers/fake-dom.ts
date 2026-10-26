// Minimal DOM, just enough to run the real page controllers (web/*.js) in Node. Not a browser: layout, CSS and real event semantics are NOT emulated.
export class FText { nodeType = 3; data: string; constructor(data: string) { this.data = data; } get textContent() { return this.data; } }
export class FEl {
  nodeType = 1; children: (FEl | FText)[] = []; attrs = new Map<string, string>(); listeners = new Map<string, ((e: any) => void)[]>(); parent: FEl | null = null;
  className = ''; _value = ''; checked = false; disabled = false; selected = false; style: any = { setProperty() {}, width: '' };
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get id() { return this.attrs.get('id') ?? ''; }
  // A <select> with nothing chosen reports its selected (else first) option, like a browser.
  get value(): string { if (this.tagName === 'SELECT' && this._value === '') { const opts = this.all((e) => e.tagName === 'OPTION'); const o = opts.find((x) => x.selected) ?? opts[0]; return o ? (o._value || o.getAttribute('value') || o.textContent) : ''; } return this._value; }
  set value(v: string) { this._value = v; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); if (k === 'value') this._value = v; if (k === 'class') this.className = v; }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  appendChild(c: FEl | FText) { if (c instanceof FEl) c.parent = this; this.children.push(c); return c; }
  replaceChildren(...cs: (FEl | FText)[]) { this.children = []; cs.forEach((c) => this.appendChild(c)); }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners.get(t) ?? this.listeners.set(t, []).get(t)!).push(fn); }
  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = [new FText(String(v))]; }
  get classList() { const self = this; return { add: (c: string) => { self.className += ' ' + c; }, remove() {}, contains: (c: string) => self.className.split(' ').includes(c) }; }
  walk(fn: (e: FEl) => boolean | void): FEl | null { for (const c of this.children) if (c instanceof FEl) { if (fn(c)) return c; const r = c.walk(fn); if (r) return r; } return null; }
  all(pred: (e: FEl) => boolean): FEl[] { const out: FEl[] = []; this.walk((e) => { if (pred(e)) out.push(e); }); return out; }
  querySelector(sel: string): FEl | null { return this.walk(matcher(sel)); }
  querySelectorAll(sel: string): FEl[] { return this.all(matcher(sel)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  click() {}
}
function matcher(sel: string): (e: FEl) => boolean {
  if (sel.startsWith('#')) return (e) => e.id === sel.slice(1);
  const m = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(sel); if (m) return (e) => e.attrs.has(m[1]) && (m[2] === undefined || e.attrs.get(m[1]) === m[2]);
  return (e) => e.tagName === sel.toUpperCase();
}
export function installDom() {
  const body = new FEl('BODY'); const root = new FEl('DIV'); root.setAttribute('id', 'app'); body.appendChild(root);
  const doc: any = { body, documentElement: new FEl('HTML'), activeElement: null, createElement: (t: string) => new FEl(t.toUpperCase()), createTextNode: (s: string) => new FText(s), getElementById: (id: string) => (id === 'app' ? root : body.walk((e) => e.id === id)) };
  (globalThis as any).document = doc; (globalThis as any).__root = root;
  return { root, doc };
}
export const text = (el: FEl) => el.textContent.replace(/\s+/g, ' ').trim();
export const findAll = (root: FEl, pred: (e: FEl) => boolean) => root.all(pred);
export const byId = (root: FEl, id: string) => root.querySelector('#' + id);
export const buttonByText = (root: FEl, s: string | RegExp) => root.walk((e) => e.tagName === 'BUTTON' && (typeof s === 'string' ? text(e) === s || text(e).includes(s) : s.test(text(e)))) as FEl | null;
export async function click(el: FEl | null) { if (!el) throw new Error('element not found to click'); if (el.disabled) return; for (const fn of el.listeners.get('click') ?? []) await fn({ target: el, preventDefault() {} }); }
export async function type(el: FEl | null, value: string) { if (!el) throw new Error('input not found'); el.value = value; for (const fn of el.listeners.get('input') ?? []) await fn({ target: el }); }
export async function choose(el: FEl | null, value: string) { if (!el) throw new Error('select not found'); el.value = value; for (const fn of el.listeners.get('change') ?? []) await fn({ target: el }); }

/** Manual timers so tests control polling without real waits. */
export function fakeTimers() {
  let id = 1; const iv = new Map<number, () => void>(); const to = new Map<number, () => void>();
  return {
    setInterval: (fn: () => void) => { iv.set(id, fn); return id++; }, clearInterval: (n: number) => { iv.delete(n); },
    setTimeout: (fn: () => void) => { to.set(id, fn); return id++; }, clearTimeout: (n: number) => { to.delete(n); },
    async fireIntervals() { for (const fn of [...iv.values()]) await fn(); }, async fireTimeouts() { const fns = [...to.values()]; to.clear(); for (const fn of fns) await fn(); }, count: () => iv.size,
  };
}
/** Waits until predicate is true (microtask/IO friendly). */
export async function until(pred: () => boolean, ms = 3000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) { const r = (globalThis as any).__root; throw new Error('timed out waiting for UI state. Screen shows: ' + (r ? text(r).slice(-500) : '?') + ' | wanted: ' + pred.toString().slice(0, 140)); } await new Promise((r) => setTimeout(r, 10)); } }
