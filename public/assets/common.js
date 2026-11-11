// a page opened inside the counter screen (?embed=1) hides its own navigation, so the counter page never reloads
if (/[?&]embed=1/.test(location.search)) document.documentElement.classList.add('embed');
async function api(path, opts) {
  opts = opts || {};
  const r = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 401 && !path.startsWith('/api/login')) { location.href = '/'; throw new Error('login'); }
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const e = new Error(j.error || ('Error ' + r.status)); e.status = r.status; e.data = j; throw e; }
  return j;
}
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeStr = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dateStr = ms => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
// how an order was paid, for people to read: Cash / UPI / Card / Cash ₹300 + Online ₹198
const payText = o => o.pay_mode === 'split' ? 'Cash ' + rupee(o.pay_cash) + ' + Online ' + rupee(o.pay_online) : ({ cash: 'Cash', upi: 'UPI', card: 'Card' }[o.pay_mode] || '');
// English name first, Hindi underneath-style (for the customer menu, counter and owner screens)
const bi = i => esc(i.name || i.name_hi) + (i.variant ? ' (' + esc(i.variant) + ')' : '') +
  (i.name_hi && i.name_hi !== i.name ? ' <span class="muted">' + esc(i.name_hi) + (i.variant_hi ? ' (' + esc(i.variant_hi) + ')' : '') + '</span>' : '');
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

const ICON = {
  back: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></svg>',
  look: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 100 18c1.7 0 2-1.2 1.4-2.2-.7-1.2.1-2.3 1.4-2.3H17a4 4 0 004-4c0-5-4-9.5-9-9.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/></svg>',
  out: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a1 1 0 00-1 1v14a1 1 0 001 1h4M16 8l4 4-4 4M20 12H9"/></svg>',
};

// light / dark theme and the three looks, remembered on this device
const LOOKS = [
  { id: 'brand', label: 'Baithak green', note: 'your logo colours', theme: 'light' },
  { id: 'indigo', label: 'Chikan indigo', note: 'bright and crisp', theme: 'light' },
  { id: 'nawabi', label: 'Nawabi night', note: 'parchment, gold, dark by default', theme: 'dark' },
];
function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function currentLook() { return document.documentElement.dataset.palette || 'brand'; }
function syncChrome() {
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = getComputedStyle(document.documentElement).getPropertyValue('--bar').trim() || '#0a5a44';
  document.querySelectorAll('[data-theme-btn]').forEach(b => { b.innerHTML = currentTheme() === 'dark' ? ICON.sun : ICON.moon; });
  document.querySelectorAll('[data-look-btn]').forEach(b => { b.innerHTML = ICON.look; });
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) {}
  syncChrome();
}
function setLook(id, keepTheme) {
  const l = LOOKS.find(x => x.id === id) || LOOKS[0];
  document.documentElement.dataset.palette = l.id;
  try { localStorage.setItem('look', l.id); } catch (e) {}
  if (!keepTheme) setTheme(l.theme); else syncChrome();
}
async function chooseLook() {
  const hi = document.documentElement.lang === 'hi';
  const v = await pick(hi ? 'रंग-रूप चुनें' : 'Choose a look', LOOKS.map(l => ({ label: l.label + (l.id === currentLook() ? '  ✔' : '') + ' – ' + l.note, value: l.id })));
  if (v) setLook(v);
}
function mountThemeButtons() {
  document.querySelectorAll('[data-theme-btn]').forEach(b => { b.onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); });
  document.querySelectorAll('[data-look-btn]').forEach(b => { b.onclick = chooseLook; });
  syncChrome();
}

let toastTimer;
// toast('text'), toast('text', true) for an error, or toast('text', {action:{label, fn}, ms})
function toast(msg, opt) {
  const o = opt === true ? { err: true } : (opt || {});
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.innerHTML = '<span></span>';
  t.firstChild.textContent = msg;
  if (o.action) {
    const b = document.createElement('button');
    b.textContent = o.action.label;
    b.onclick = () => { t.className = ''; clearTimeout(toastTimer); o.action.fn(); };
    t.appendChild(b);
  }
  t.className = 'show' + (o.err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, o.ms || (o.err ? 4000 : o.action ? 5500 : 2000));
}

// live updates from the server; reconnects by itself if the connection drops
function live(onEvent) {
  let es;
  const open = () => {
    es = new EventSource('/api/events');
    es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (x) {} };
    es.onerror = () => { es.close(); setTimeout(open, 3000); };
  };
  open();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onEvent({ type: 'resync' }); });
}

// small "choose one" popup. options: [{label, value, danger}] -> resolves to value, or null if closed
function pick(title, options) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="box"><h3></h3></div>';
    ov.querySelector('h3').textContent = title;
    const box = ov.querySelector('.box');
    options.forEach(o => {
      const b = document.createElement('button');
      b.className = 'opt' + (o.danger ? ' danger' : '');
      b.textContent = o.label;
      b.onclick = () => { ov.remove(); resolve(o.value); };
      box.appendChild(b);
    });
    const c = document.createElement('button');
    c.className = 'opt ghost'; c.textContent = document.documentElement.lang === 'hi' ? 'बंद करें' : 'Close';
    c.onclick = () => { ov.remove(); resolve(null); };
    box.appendChild(c);
    ov.addEventListener('click', e => { if (e.target === ov) { ov.remove(); resolve(null); } });
    document.body.appendChild(ov);
  });
}

async function logout() { try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) {} location.href = '/?choose'; }
