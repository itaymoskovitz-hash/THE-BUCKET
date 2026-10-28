// Tiny DOM helpers, icon set, toasts and dialogs. No framework.

/** h('div.card#id', {attrs/on*}, ...children) */
export function h(tag, props, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]+)?(.*)$/i);
  const el = document.createElement(name);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props); props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Consistent 24px stroke icon set (Lucide-style geometry, drawn here so there is no dependency).
const P = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  pencil: 'M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM22 6l-10 7L2 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  arrowRight: 'M5 12h14M13 5l7 7-7 7',
  wifiOff: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M12 20h.01',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z',
  crown: 'M2 18h20M3 7l5 4 4-7 4 7 5-4-2 11H5Z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4Z',
  bucket: 'M4 8h16l-1.6 11.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8ZM7 8a5 5 0 0 1 10 0',
  chevronDown: 'm6 9 6 6 6-6',
};
export function icon(name, size = 20, label) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('class', 'icon');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[name] || '');
  svg.append(path);
  return svg;
}

// ── Toasts (polite live region) ──
let toastHost;
export function toast(message, { kind = 'info', action, timeout = 3500 } = {}) {
  toastHost ||= document.getElementById('toasts');
  const t = h('div.toast', { class: `toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', message),
    action && h('button.btn.btn-text', { type: 'button', onclick: () => { action.run(); t.remove(); } }, action.label));
  toastHost.append(t);
  setTimeout(() => t.remove(), timeout);
}

// ── Modal dialogs on top of native <dialog> (focus trap + Esc for free) ──
export function openDialog({ title, body, actions, onClose, labelledBy = 'dlg-title' }) {
  const dlg = h('dialog.dialog', { 'aria-labelledby': labelledBy },
    h('form.dialog-inner', { method: 'dialog', onsubmit: (e) => e.preventDefault() },
      h('h2.dialog-title#' + labelledBy, title),
      body,
      h('div.dialog-actions', actions)));
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = openDialog({
      title,
      body: h('p.muted', message),
      onClose: () => resolve(result),
      actions: [
        h('button.btn.btn-secondary', { type: 'button', onclick: () => dlg.close() }, 'ביטול'),
        h('button.btn', { type: 'button', class: danger ? 'btn-danger' : 'btn-primary',
          onclick: () => { result = true; dlg.close(); } }, confirmLabel),
      ],
    });
  });
}

/** Run an async action while a button shows a busy state; prevents double submits. */
export async function busy(btn, fn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally {
    delete btn.dataset.busy; btn.disabled = false; btn.removeAttribute('aria-busy');
  }
}

export function fieldError(form, message) {
  let box = form.querySelector('.form-error');
  if (!box) { box = h('p.form-error', { role: 'alert' }); form.prepend(box); }
  box.textContent = message || '';
  box.hidden = !message;
}

export const fmtDate = (d) => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

/** Wrap Latin/mixed text so it renders correctly inside RTL. */
export const bdi = (text) => h('bdi', text);
