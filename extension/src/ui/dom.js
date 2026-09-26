// Tiny DOM builder. Always sets text via textContent — never innerHTML — because
// usernames and titles can come from web pages.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || (v === false && !(k in el))) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by our strict CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).then((res) => {
    if (!res) throw new Error('No response from Helium Vault.');
    if (!res.ok) {
      const err = new Error(res.error);
      err.locked = res.locked;
      throw err;
    }
    return res;
  });
}

export function initial(text) {
  return (text || '?').trim().charAt(0) || '?';
}

export const KEY_ICON = '\u{1F511}';
