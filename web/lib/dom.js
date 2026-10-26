// Tiny DOM helper. Text is always inserted as text nodes (no HTML parsing), so user-controlled strings cannot inject markup.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
export function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function mount(root, ...kids) { root.replaceChildren(...kids.flat(Infinity).filter((k) => k !== undefined && k !== null && k !== false)); }
export const $ = (id) => document.getElementById(id);
