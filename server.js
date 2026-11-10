// The Baithak Stories - orders, kitchen tickets, billing and stats.
// One small Node server + one SQLite file. No build step.
const express = require('express');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------- config (all overridable with environment variables) ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // on Railway: point this at the volume mount
const TZ_MIN = Number(process.env.TZ_OFFSET_MIN || 330); // India = UTC+5:30
const TABLES = Number(process.env.TABLES || 12);
const LOOK = ['brand', 'indigo', 'nawabi'].includes(process.env.LOOK) ? process.env.LOOK : 'nawabi'; // default look for devices that have not picked one
const THEME = ['light', 'dark'].includes(process.env.THEME) ? process.env.THEME : (LOOK === 'nawabi' ? 'dark' : 'light');
const BUILD = String(Date.now()); // changes on every restart, so browsers never mix old and new files
const GRACE_SEC = Number(process.env.GRACE_SEC === undefined ? 120 : process.env.GRACE_SEC); // waiter can delete a just-sent item instantly for this long
const RESTAURANT = process.env.RESTAURANT_NAME || 'The Baithak Stories';
const PHONE = process.env.RESTAURANT_PHONE || '8400493350, 7207368810';
const TAX_PERCENT = Number(process.env.TAX_PERCENT || 0); // set only after confirming the GST rule with your CA
const PINS = {
  waiter: process.env.WAITER_PIN || '1111',
  counter: process.env.COUNTER_PIN || '2222',
  kitchen: process.env.KITCHEN_PIN || '3333',
  owner: process.env.OWNER_PIN || '9999',
};
const DEFAULT_PINS = !process.env.WAITER_PIN || !process.env.COUNTER_PIN || !process.env.OWNER_PIN || !process.env.KITCHEN_PIN;
if (new Set(Object.values(PINS)).size < Object.keys(PINS).length) console.warn('WARNING: two roles share the same PIN. Give each role its own PIN.');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'baithak.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS menu(
  id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, category_hi TEXT, name TEXT, name_hi TEXT,
  variant TEXT DEFAULT '', variant_hi TEXT DEFAULT '', price INTEGER NOT NULL, available INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, day_no INTEGER, type TEXT, table_no INTEGER, customer TEXT DEFAULT '',
  status TEXT DEFAULT 'open', bill_requested INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER,
  paid_at INTEGER, pay_mode TEXT, bill_no INTEGER, subtotal INTEGER DEFAULT 0, discount INTEGER DEFAULT 0,
  tax INTEGER DEFAULT 0, total INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS kots(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, note TEXT DEFAULT '', created_by TEXT,
  created_at INTEGER, printed_at INTEGER);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, kot_id INTEGER, menu_id INTEGER, name TEXT, name_hi TEXT,
  variant TEXT, variant_hi TEXT, price INTEGER, qty INTEGER, status TEXT DEFAULT 'active',
  void_reason TEXT, void_by TEXT, void_at INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, role TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS login_fail(ip TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_paid ON orders(paid_at);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

// upgrades for databases created by an earlier version
for (const col of ["ALTER TABLE kots ADD COLUMN client_id TEXT", "ALTER TABLE kots ADD COLUMN kind TEXT DEFAULT 'order'", "ALTER TABLE kots ADD COLUMN payload TEXT",
  "ALTER TABLE kots ADD COLUMN ready_at INTEGER", "ALTER TABLE kots ADD COLUMN served_at INTEGER",
  "ALTER TABLE orders ADD COLUMN bill_issued_at INTEGER", "ALTER TABLE orders ADD COLUMN pay_confirm TEXT", "ALTER TABLE orders ADD COLUMN pay_confirm_at INTEGER",
  "ALTER TABLE orders ADD COLUMN pay_fixed_from TEXT", "ALTER TABLE orders ADD COLUMN pay_fixed_reason TEXT", "ALTER TABLE orders ADD COLUMN pay_fixed_at INTEGER",
  "ALTER TABLE orders ADD COLUMN pay_cash INTEGER", "ALTER TABLE orders ADD COLUMN pay_online INTEGER"]) {
  try { db.exec(col); } catch (e) { /* column already there */ }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_kots_client ON kots(client_id) WHERE client_id IS NOT NULL");
// tickets that were printed under the old way count as done, so the new kitchen screen starts clean
db.exec("UPDATE kots SET ready_at=printed_at WHERE ready_at IS NULL AND printed_at IS NOT NULL");

// seed the menu on first run
if (db.prepare('SELECT COUNT(*) c FROM menu').get().c === 0) {
  const data = require('./menu-data');
  const ins = db.prepare('INSERT INTO menu(category,category_hi,name,name_hi,variant,variant_hi,price,sort) VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    let sort = 0;
    for (const cat of data) {
      for (const [en, hi, p] of cat.items) {
        if (Array.isArray(p)) for (const [v, price] of p) ins.run(cat.en, cat.hi, en, hi, v, data.VARIANT_HI[v] || v, price, sort++);
        else ins.run(cat.en, cat.hi, en, hi, '', '', p, sort++);
      }
    }
  })();
  console.log('Menu loaded:', db.prepare('SELECT COUNT(*) c FROM menu').get().c, 'rows');
}

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const h = fn => (req, res) => {
  try { fn(req, res); } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
};
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const localDate = ms => new Date(ms + TZ_MIN * 60000).toISOString().slice(0, 10);
function dayRange(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) bad('Invalid date');
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - TZ_MIN * 60000;
  return [start, start + 86400000];
}

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function broadcast(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch { clients.delete(c); } } }, 25000);

// ---------- auth ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionRole(req) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  const row = db.prepare('SELECT role FROM sessions WHERE token=?').get(t);
  return row ? row.role : null;
}
const need = (...roles) => (req, res, next) => {
  const role = sessionRole(req);
  if (!role) return res.status(401).json({ error: 'Login required' });
  if (!roles.includes(role)) return res.status(403).json({ error: 'Not allowed' });
  req.role = role; next();
};
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

app.post('/api/login', h((req, res) => {
  const ip = req.ip;
  const now = Date.now();
  db.prepare('DELETE FROM login_fail WHERE at < ?').run(now - 600000);
  if (db.prepare('SELECT COUNT(*) c FROM login_fail WHERE ip=?').get(ip).c >= 8) bad('Too many wrong PINs. Try again in 10 minutes.', 429);
  const pin = String((req.body || {}).pin || '');
  const door = (req.body || {}).as; // 'waiter', 'kitchen' or 'admin' (the door chosen on the front page)
  let role = null;
  for (const r of ['owner', 'counter', 'kitchen', 'waiter']) if (same(pin, PINS[r])) { role = r; break; }
  if (!role) { db.prepare('INSERT INTO login_fail(ip,at) VALUES (?,?)').run(ip, now); bad('Wrong PIN', 401); }
  const pinDoor = role === 'waiter' ? 'waiter' : role === 'kitchen' ? 'kitchen' : 'admin';
  if (door && ['waiter', 'kitchen', 'admin'].includes(door) && door !== pinDoor) {
    db.prepare('INSERT INTO login_fail(ip,at) VALUES (?,?)').run(ip, now); // counts as a failed try, so PINs cannot be guessed through the wrong door
    return res.status(403).json({ error: 'This PIN belongs to the other door', door: pinDoor });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,role,created_at) VALUES (?,?,?)').run(token, role, now);
  const secure = req.protocol === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ role });
}));
app.post('/api/logout', (req, res) => {
  const t = parseCookies(req).sid;
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', h((req, res) => {
  const role = sessionRole(req);
  if (!role) return res.status(401).json({ error: 'Login required' });
  res.json({ role, restaurant: RESTAURANT, tables: TABLES, taxPercent: TAX_PERCENT, phone: PHONE, graceSec: GRACE_SEC, defaultPins: DEFAULT_PINS && role === 'owner' });
}));
app.get('/api/events', need('waiter', 'kitchen', 'counter', 'owner'), (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---------- menu ----------
app.get('/api/menu', need('waiter', 'counter', 'owner'), (req, res) => {
  res.json(db.prepare('SELECT * FROM menu ORDER BY sort, id').all());
});
const menuFields = b => {
  const price = int(b.price);
  if (!b.name || !String(b.name).trim()) bad('Name needed');
  if (price === null || price < 0) bad('Price must be a whole number');
  return [String(b.category || 'Other').trim(), String(b.category_hi || b.category || 'अन्य').trim(), String(b.name).trim(),
    String(b.name_hi || b.name).trim(), String(b.variant || '').trim(), String(b.variant_hi || b.variant || '').trim(), price, b.available === 0 || b.available === false ? 0 : 1];
};
app.put('/api/menu/:id', need('owner'), h((req, res) => {
  const f = menuFields(req.body || {});
  const r = db.prepare('UPDATE menu SET category=?,category_hi=?,name=?,name_hi=?,variant=?,variant_hi=?,price=?,available=? WHERE id=?').run(...f, req.params.id);
  if (!r.changes) bad('Not found', 404);
  broadcast('menu'); res.json({ ok: true });
}));
app.post('/api/menu', need('owner'), h((req, res) => {
  const f = menuFields(req.body || {});
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM menu').get().s;
  const r = db.prepare('INSERT INTO menu(category,category_hi,name,name_hi,variant,variant_hi,price,available,sort) VALUES (?,?,?,?,?,?,?,?,?)').run(...f, sort);
  broadcast('menu'); res.json({ id: r.lastInsertRowid });
}));

// ---------- public menu (no login): what customers see ----------
app.get('/api/public/menu', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    restaurant: RESTAURANT, phone: PHONE, tables: TABLES,
    items: db.prepare('SELECT category, category_hi, name, name_hi, variant, variant_hi, price, available FROM menu ORDER BY sort, id').all(),
  });
});

// ---------- orders ----------
function loadOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.kots = db.prepare("SELECT id,note,created_by,created_at,ready_at,served_at FROM kots WHERE order_id=? AND COALESCE(kind,'order')='order' ORDER BY id").all(id);
  o.running_total = o.items.filter(i => i.status !== 'voided').reduce((s, i) => s + i.price * i.qty, 0);
  o.pending_voids = o.items.filter(i => i.status === 'void_requested').length;
  o.bill_stale = !!(o.status === 'open' && o.bill_issued_at && o.subtotal !== o.running_total); // items changed after the bill was printed
  return o;
}
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) bad('Add at least one item');
  if (items.length > 60) bad('Too many items');
  return items.map(i => {
    const menu_id = int(i && i.menu_id), qty = int(i && i.qty);
    if (!menu_id || !qty || qty < 1 || qty > 50) bad('Bad item or quantity');
    return { menu_id, qty };
  });
}
function addKot(orderId, items, note, role, now, clientId) {
  const order = db.prepare('SELECT status FROM orders WHERE id=?').get(orderId);
  if (!order) bad('Order not found', 404);
  if (order.status !== 'open') bad('Order is already closed', 409);
  const kot = db.prepare('INSERT INTO kots(order_id,note,created_by,created_at,client_id) VALUES (?,?,?,?,?)')
    .run(orderId, String(note || '').slice(0, 200), role, now, clientId || null);
  const getMenu = db.prepare('SELECT * FROM menu WHERE id=?');
  const ins = db.prepare('INSERT INTO order_items(order_id,kot_id,menu_id,name,name_hi,variant,variant_hi,price,qty,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const it of items) {
    const m = getMenu.get(it.menu_id);
    if (!m) bad('Menu item not found');
    if (!m.available) bad(`${m.name} is not available right now`);
    ins.run(orderId, kot.lastInsertRowid, m.id, m.name, m.name_hi, m.variant, m.variant_hi, m.price, it.qty, now);
  }
  return Number(kot.lastInsertRowid);
}

const cleanClientId = v => (typeof v === 'string' && /^[\w-]{8,64}$/.test(v)) ? v : null;
const kotByClient = id => id ? db.prepare('SELECT id, order_id FROM kots WHERE client_id=?').get(id) : null;

app.post('/api/orders', need('waiter', 'counter', 'owner'), h((req, res) => {
  const { type, table_no, customer, items, note } = req.body || {};
  const clientId = cleanClientId((req.body || {}).client_id);
  const dup = kotByClient(clientId); // the same send arriving twice (bad network retry) must not make two tickets
  if (dup) return res.json({ orderId: dup.order_id, kotId: dup.id, order: loadOrder(dup.order_id), duplicate: true });
  if (!['dine_in', 'takeaway'].includes(type)) bad('Bad order type');
  const list = cleanItems(items);
  let tno = null;
  if (type === 'dine_in') { tno = int(table_no); if (!tno || tno < 1 || tno > TABLES) bad('Bad table number'); }
  const out = db.transaction(() => {
    const now = Date.now();
    let order = type === 'dine_in'
      ? db.prepare("SELECT id FROM orders WHERE status='open' AND type='dine_in' AND table_no=?").get(tno) : null;
    if (!order) {
      const [s, e] = dayRange(localDate(now));
      const day_no = db.prepare('SELECT COUNT(*)+1 n FROM orders WHERE created_at>=? AND created_at<?').get(s, e).n;
      const r = db.prepare('INSERT INTO orders(day_no,type,table_no,customer,created_by,created_at) VALUES (?,?,?,?,?,?)')
        .run(day_no, type, tno, String(customer || '').slice(0, 60), req.role, now);
      order = { id: Number(r.lastInsertRowid) };
    }
    const kotId = addKot(order.id, list, note, req.role, now, clientId);
    return { orderId: order.id, kotId };
  })();
  broadcast('kot', { order_id: out.orderId, kot_id: out.kotId });
  res.json({ ...out, order: loadOrder(out.orderId) });
}));

app.post('/api/orders/:id/items', need('waiter', 'counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const clientId = cleanClientId((req.body || {}).client_id);
  const dup = kotByClient(clientId);
  if (dup) return res.json({ kotId: dup.id, order: loadOrder(dup.order_id), duplicate: true });
  const list = cleanItems((req.body || {}).items);
  const kotId = db.transaction(() => addKot(id, list, (req.body || {}).note, req.role, Date.now(), clientId))();
  db.prepare('UPDATE orders SET bill_requested=0 WHERE id=?').run(id);
  broadcast('kot', { order_id: id, kot_id: kotId });
  res.json({ kotId, order: loadOrder(id) });
}));

app.get('/api/orders/open', need('waiter', 'counter', 'owner'), (req, res) => {
  const ids = db.prepare("SELECT id FROM orders WHERE status='open' ORDER BY created_at").all();
  res.json(ids.map(r => loadOrder(r.id)));
});
app.get('/api/orders/:id', need('waiter', 'counter', 'owner'), h((req, res) => {
  const o = loadOrder(int(req.params.id));
  if (!o) bad('Not found', 404);
  if (req.role === 'waiter') { delete o.pay_mode; delete o.pay_confirm; delete o.pay_cash; delete o.pay_online; }
  res.json(o);
}));
app.get('/api/orders', need('counter', 'owner'), h((req, res) => {
  const [s, e] = dayRange(req.query.date || localDate(Date.now()));
  const ids = db.prepare('SELECT id FROM orders WHERE created_at>=? AND created_at<? ORDER BY created_at DESC').all(s, e);
  res.json(ids.map(r => loadOrder(r.id)));
}));

app.post('/api/orders/:id/bill-request', need('waiter', 'counter', 'owner'), h((req, res) => {
  const r = db.prepare("UPDATE orders SET bill_requested=1 WHERE id=? AND status='open'").run(int(req.params.id));
  if (!r.changes) bad('Order not open', 409);
  broadcast('bill', { order_id: int(req.params.id) });
  res.json({ ok: true });
}));

// voids: the owner removes instantly. Waiter/counter can remove instantly for GRACE_SEC after sending
// (a mis-tap), after that the owner has to approve.
function cancelSlip(orderId, items, reason) {
  // tell the kitchen to stop making these items, unless that ticket is already marked ready
  const live = items.filter(i => { const k = db.prepare('SELECT ready_at FROM kots WHERE id=?').get(i.kot_id); return k && !k.ready_at; });
  if (!live.length) return;
  const payload = JSON.stringify(live.map(i => ({ name: i.name, name_hi: i.name_hi, variant: i.variant, variant_hi: i.variant_hi, qty: i.qty })));
  const r = db.prepare("INSERT INTO kots(order_id,note,created_by,created_at,kind,payload) VALUES (?,?,?,?,'cancel',?)")
    .run(orderId, reason || '', 'system', Date.now(), payload);
  broadcast('kot', { order_id: orderId, kot_id: Number(r.lastInsertRowid), kind: 'cancel' });
}
function requestVoid(itemId, reason, role, collect) {
  const it = db.prepare('SELECT i.*, o.status ostatus FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=?').get(itemId);
  if (!it) bad('Item not found', 404);
  if (it.ostatus !== 'open') bad('Order is already closed', 409);
  if (it.status !== 'active') return { oid: it.order_id, voided: false };
  const now = Date.now();
  const quick = role === 'owner' || (GRACE_SEC > 0 && now - it.created_at <= GRACE_SEC * 1000);
  if (quick) {
    db.prepare("UPDATE order_items SET status='voided', void_reason=?, void_by=?, void_at=? WHERE id=?")
      .run(reason, role === 'owner' ? 'owner' : role + ' (quick)', now, itemId);
    closeIfEmpty(it.order_id);
    if (collect) collect.push(it); else cancelSlip(it.order_id, [it], reason);
    return { oid: it.order_id, voided: true };
  }
  db.prepare("UPDATE order_items SET status='void_requested', void_reason=?, void_by=?, void_at=? WHERE id=?").run(reason, role, now, itemId);
  return { oid: it.order_id, voided: false };
}
function closeIfEmpty(orderId) {
  const left = db.prepare("SELECT COUNT(*) c FROM order_items WHERE order_id=? AND status!='voided'").get(orderId).c;
  if (!left) db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='open'").run(orderId);
}
app.post('/api/items/:id/void-request', need('waiter', 'counter', 'owner'), h((req, res) => {
  const reason = String((req.body || {}).reason || '').slice(0, 100) || 'No reason';
  const r = requestVoid(int(req.params.id), reason, req.role);
  broadcast('void', { order_id: r.oid });
  res.json({ order: loadOrder(r.oid), voided: r.voided });
}));
app.post('/api/orders/:id/cancel-request', need('waiter', 'counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const reason = String((req.body || {}).reason || '').slice(0, 100) || 'Order cancelled';
  const ids = db.prepare("SELECT id FROM order_items WHERE order_id=? AND status='active'").all(id);
  const collect = [];
  db.transaction(() => ids.forEach(r => requestVoid(r.id, reason, req.role, collect)))();
  if (collect.length) cancelSlip(id, collect, reason);
  broadcast('void', { order_id: id });
  res.json({ order: loadOrder(id) });
}));
app.post('/api/items/:id/void-decision', need('owner'), h((req, res) => {
  const id = int(req.params.id);
  const it = db.prepare('SELECT * FROM order_items WHERE id=?').get(id);
  if (!it || it.status !== 'void_requested') bad('No pending request', 409);
  if ((req.body || {}).approve) {
    db.prepare("UPDATE order_items SET status='voided', void_by=void_by||' (approved)' WHERE id=?").run(id);
    closeIfEmpty(it.order_id);
    cancelSlip(it.order_id, [it], it.void_reason);
  } else {
    db.prepare("UPDATE order_items SET status='active', void_reason=NULL, void_by=NULL, void_at=NULL WHERE id=?").run(id);
  }
  broadcast('void', { order_id: it.order_id });
  res.json({ order: loadOrder(it.order_id) });
}));
app.get('/api/voids', need('owner'), h((req, res) => {
  const q = `SELECT i.id,i.order_id,i.name,i.variant,i.qty,i.price,i.status,i.void_reason,i.void_by,i.void_at,o.day_no,o.type,o.table_no
             FROM order_items i JOIN orders o ON o.id=i.order_id`;
  if (req.query.pending) return res.json(db.prepare(q + " WHERE i.status='void_requested' ORDER BY i.void_at").all());
  const [s, e] = dayRange(req.query.date || localDate(Date.now()));
  res.json(db.prepare(q + " WHERE i.status IN ('voided','void_requested') AND i.void_at>=? AND i.void_at<? ORDER BY i.void_at DESC").all(s, e));
}));

// ---------- billing ----------
// Printing a bill "issues" it (gives it a number and locks the amount). The next bill cannot be printed until
// the counter has ticked Cash / UPI / Card for the one before. The waiter then confirms how the guest really paid.
function billFigures(orderId, role, bodyDiscount) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) bad('Not found', 404);
  if (o.status !== 'open') bad('Already closed', 409);
  if (db.prepare("SELECT COUNT(*) c FROM order_items WHERE order_id=? AND status='void_requested'").get(orderId).c)
    bad('There are item-removal requests waiting for the owner. Approve or reject them first.', 409);
  const subtotal = db.prepare("SELECT COALESCE(SUM(price*qty),0) s FROM order_items WHERE order_id=? AND status!='voided'").get(orderId).s;
  if (!subtotal) bad('Nothing to bill');
  let discount = role === 'owner' && bodyDiscount !== undefined && bodyDiscount !== '' ? (int(bodyDiscount) || 0) : (o.discount || 0);
  discount = Math.max(0, Math.min(discount, subtotal));
  const tax = Math.round((subtotal - discount) * TAX_PERCENT / 100);
  return { o, subtotal, discount, tax, total: subtotal - discount + tax };
}
// "cash + online": the counter says how much was cash, the rest was online (UPI)
function splitParts(mode, cash, total) {
  if (mode !== 'split') return [null, null];
  const c = int(cash);
  if (c === null || c < 1 || c >= total) bad('Enter the cash amount: more than 0 and less than the total of ₹' + total);
  return [c, total - c];
}
const nextBillNo = () => db.prepare('SELECT COALESCE(MAX(bill_no),0)+1 n FROM orders').get().n;
// the bill that was printed but not yet marked paid (if any), other than `exceptId`
function unmarkedBill(exceptId) {
  return db.prepare("SELECT id,type,table_no,day_no,customer,bill_no,total FROM orders WHERE status='open' AND bill_issued_at IS NOT NULL AND id!=? ORDER BY bill_issued_at LIMIT 1").get(exceptId || 0);
}
const whereName = o => o.type === 'dine_in' ? 'Table ' + o.table_no : 'Parcel #' + o.day_no;

app.post('/api/orders/:id/bill', need('counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const block = unmarkedBill(id);
  if (block) return res.status(409).json({ error: `Mark how ${whereName(block)} paid (Cash, UPI or Card) before printing the next bill.`, blocking: block });
  const out = db.transaction(() => {
    const f = billFigures(id, req.role, (req.body || {}).discount);
    const bill_no = f.o.bill_no || nextBillNo();
    db.prepare('UPDATE orders SET bill_no=?, subtotal=?, discount=?, tax=?, total=?, bill_issued_at=? WHERE id=?')
      .run(bill_no, f.subtotal, f.discount, f.tax, f.total, Date.now(), id);
    return id;
  })();
  broadcast('bill', { order_id: out });
  res.json({ order: loadOrder(out) });
}));

app.post('/api/orders/:id/pay', need('counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const { mode } = req.body || {};
  if (!['cash', 'upi', 'card', 'split'].includes(mode)) bad('Choose cash, UPI, card or cash + online');
  const out = db.transaction(() => {
    const f = billFigures(id, req.role, (req.body || {}).discount);
    const bill_no = f.o.bill_no || nextBillNo();
    const [pc, po] = splitParts(mode, (req.body || {}).cash, f.total);
    db.prepare("UPDATE orders SET status='paid', paid_at=?, pay_mode=?, pay_cash=?, pay_online=?, bill_no=?, subtotal=?, discount=?, tax=?, total=?, bill_requested=0 WHERE id=?")
      .run(Date.now(), mode, pc, po, bill_no, f.subtotal, f.discount, f.tax, f.total, id);
    return { id, wasIssued: !!f.o.bill_issued_at };
  })();
  broadcast('paid', { order_id: out.id });
  res.json({ order: loadOrder(out.id), wasIssued: out.wasIssued });
}));

// the waiter's own answer to "how did the guest pay?" (he is never shown what the counter chose)
app.get('/api/payments/confirm', need('waiter', 'owner'), h((req, res) => {
  const rows = db.prepare("SELECT id,table_no,day_no,total,paid_at FROM orders WHERE status='paid' AND type='dine_in' AND pay_confirm IS NULL AND paid_at>? ORDER BY paid_at")
    .all(Date.now() - 4 * 3600000);
  res.json(rows);
}));
app.post('/api/orders/:id/confirm-payment', need('waiter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const mode = (req.body || {}).mode;
  if (!['cash', 'upi', 'card', 'split'].includes(mode)) bad('Choose how the guest paid');
  const o = db.prepare('SELECT status,type,pay_mode,pay_confirm FROM orders WHERE id=?').get(id);
  if (!o || o.status !== 'paid' || o.type !== 'dine_in') bad('Nothing to confirm', 409);
  if (o.pay_confirm) return res.json({ ok: true });
  db.prepare('UPDATE orders SET pay_confirm=?, pay_confirm_at=? WHERE id=?').run(mode, Date.now(), id);
  if (mode !== o.pay_mode) broadcast('mismatch', { order_id: id });
  res.json({ ok: true });
}));
// owner: payments where the waiter and the counter disagree, and how many were never confirmed
app.get('/api/payments/checks', need('owner'), h((req, res) => {
  const [s, e] = dayRange(req.query.date || localDate(Date.now()));
  const rows = db.prepare("SELECT id,day_no,type,table_no,bill_no,total,paid_at,pay_mode,pay_cash,pay_online,pay_confirm,pay_confirm_at,pay_fixed_from,pay_fixed_reason FROM orders WHERE status='paid' AND paid_at>=? AND paid_at<? ORDER BY paid_at DESC").all(s, e);
  const dine = rows.filter(r => r.type === 'dine_in');
  res.json({
    dine_in_paid: dine.length,
    agreed: dine.filter(r => r.pay_confirm === r.pay_mode).length,
    unseen: dine.filter(r => r.pay_confirm === 'unseen').length,
    waiting: dine.filter(r => !r.pay_confirm).length,
    open_mismatches: dine.filter(r => ['cash', 'upi', 'card', 'split'].includes(r.pay_confirm) && r.pay_confirm !== r.pay_mode && !r.pay_fixed_from),
    resolved: dine.filter(r => r.pay_fixed_from),
  });
}));
// owner settles a disagreement: keep the counter's entry, or change it to what the waiter saw
app.post('/api/orders/:id/fix-payment', need('owner'), h((req, res) => {
  const id = int(req.params.id);
  const { mode, reason } = req.body || {};
  if (!['cash', 'upi', 'card', 'split'].includes(mode)) bad('Choose cash, UPI, card or cash + online');
  const o = db.prepare("SELECT status,pay_mode,total,pay_cash FROM orders WHERE id=?").get(id);
  if (!o || o.status !== 'paid') bad('Order is not paid', 409);
  // keeping a split as it is keeps its amounts; changing to a split needs the cash amount
  const same = mode === o.pay_mode;
  const [pc, po] = mode === 'split' && same && !(req.body || {}).cash ? [o.pay_cash, o.total - o.pay_cash] : splitParts(mode, (req.body || {}).cash, o.total);
  db.prepare('UPDATE orders SET pay_fixed_from=?, pay_fixed_reason=?, pay_fixed_at=?, pay_mode=?, pay_cash=?, pay_online=? WHERE id=?')
    .run(o.pay_mode, String(reason || '').slice(0, 120) || (same ? 'Checked, counter entry was right' : 'Changed by owner'), Date.now(), mode, pc, po, id);
  res.json({ order: loadOrder(id) });
}));

// ---------- kitchen: the screen on the cooks' phone ----------
// A ticket (kot) is one batch of items sent together. The kitchen marks it ready; the waiter marks it served.
function loadKot(id) {
  const k = db.prepare('SELECT * FROM kots WHERE id=?').get(id);
  if (!k) return null;
  k.order = db.prepare('SELECT day_no,type,table_no,customer FROM orders WHERE id=?').get(k.order_id);
  k.kind = k.kind || 'order';
  k.items = k.kind === 'cancel' ? JSON.parse(k.payload || '[]')
    : db.prepare("SELECT name,name_hi,variant,variant_hi,qty FROM order_items WHERE kot_id=? AND status!='voided' ORDER BY id").all(id);
  k.is_add = k.kind === 'order' && db.prepare("SELECT COUNT(*) c FROM kots WHERE order_id=? AND COALESCE(kind,'order')='order' AND id<?").get(k.order_id, id).c > 0;
  delete k.payload; delete k.client_id;
  return k;
}
app.get('/api/kitchen', need('kitchen', 'counter', 'owner'), h((req, res) => {
  const now = Date.now();
  const waiting = db.prepare(`SELECT k.id FROM kots k JOIN orders o ON o.id=k.order_id WHERE k.ready_at IS NULL AND k.created_at>?
      AND ((COALESCE(k.kind,'order')='order' AND o.status='open') OR (k.kind='cancel' AND k.created_at>?)) ORDER BY k.id`).all(now - 12 * 3600000, now - 3 * 3600000);
  const done = db.prepare(`SELECT k.id FROM kots k JOIN orders o ON o.id=k.order_id WHERE k.ready_at>? AND COALESCE(k.kind,'order')='order' AND o.status='open'
      ORDER BY k.ready_at DESC LIMIT 12`).all(now - 45 * 60000);
  res.json({
    now,
    waiting: waiting.map(r => loadKot(r.id)).filter(k => k.items.length),
    done: done.map(r => loadKot(r.id)).filter(k => k.items.length),
  });
}));
app.post('/api/kots/:id/ready', need('kitchen', 'counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const k = db.prepare('SELECT order_id, kind FROM kots WHERE id=?').get(id);
  if (!k) bad('Not found', 404);
  const r = db.prepare('UPDATE kots SET ready_at=? WHERE id=? AND ready_at IS NULL').run(Date.now(), id);
  if (r.changes) {
    if (k.kind === 'cancel') broadcast('kitchen', { kot_id: id });
    else {
      const o = db.prepare('SELECT type,table_no,day_no,customer FROM orders WHERE id=?').get(k.order_id);
      broadcast('ready', { kot_id: id, order_id: k.order_id, order_type: o.type, table_no: o.table_no, day_no: o.day_no, customer: o.customer });
    }
  }
  res.json({ ok: true });
}));
app.post('/api/kots/:id/undo-ready', need('kitchen', 'counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  const k = db.prepare('SELECT order_id FROM kots WHERE id=?').get(id);
  if (!k) bad('Not found', 404);
  db.prepare('UPDATE kots SET ready_at=NULL, served_at=NULL WHERE id=?').run(id);
  broadcast('kitchen', { kot_id: id, order_id: k.order_id });
  res.json({ ok: true });
}));
app.post('/api/kots/:id/served', need('waiter', 'counter', 'owner'), h((req, res) => {
  const id = int(req.params.id);
  db.prepare('UPDATE kots SET served_at=? WHERE id=? AND ready_at IS NOT NULL AND served_at IS NULL').run(Date.now(), id);
  broadcast('served', { kot_id: id });
  res.json({ ok: true });
}));

// names of the best-selling items of the last 30 days (no money figures), used for the waiter's quick row
app.get('/api/popular', need('waiter', 'counter', 'owner'), (req, res) => {
  const since = Date.now() - 30 * 86400000;
  const rows = db.prepare(`SELECT i.name, SUM(i.qty) q FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.created_at>=? AND i.status!='voided' AND o.status!='cancelled' GROUP BY i.name ORDER BY q DESC LIMIT 12`).all(since);
  res.json(rows.reduce((s, r) => s + r.q, 0) >= 20 ? rows.map(r => r.name) : []);
});

// ---------- stats ----------
function dayStats(dateStr) {
  const [s, e] = dayRange(dateStr);
  const offs = TZ_MIN * 60;
  const orders = db.prepare(`SELECT
      COUNT(*) total,
      SUM(type='dine_in') dine_in, SUM(type='takeaway') takeaway,
      SUM(status='open') open, SUM(status='paid') paid
    FROM orders WHERE created_at>=? AND created_at<? AND status!='cancelled'`).get(s, e);
  const cancelled = db.prepare("SELECT COUNT(*) c FROM orders WHERE created_at>=? AND created_at<? AND status='cancelled'").get(s, e).c;
  const sales = db.prepare(`SELECT COUNT(*) bills, COALESCE(SUM(total),0) total, COALESCE(SUM(discount),0) discount,
      COALESCE(SUM(CASE WHEN pay_mode='cash' THEN total WHEN pay_mode='split' THEN pay_cash END),0) cash,
      COALESCE(SUM(CASE WHEN pay_mode='upi' THEN total WHEN pay_mode='split' THEN pay_online END),0) upi,
      COALESCE(SUM(CASE WHEN pay_mode='card' THEN total END),0) card
    FROM orders WHERE status='paid' AND paid_at>=? AND paid_at<?`).get(s, e);
  const hourly = db.prepare(`SELECT CAST(strftime('%H', created_at/1000 + ?, 'unixepoch') AS INTEGER) hour, COUNT(*) orders
    FROM orders WHERE created_at>=? AND created_at<? AND status!='cancelled' GROUP BY hour ORDER BY hour`).all(offs, s, e);
  const top = db.prepare(`SELECT i.name, i.variant, SUM(i.qty) qty, SUM(i.qty*i.price) revenue
    FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.created_at>=? AND o.created_at<? AND i.status!='voided' AND o.status!='cancelled'
    GROUP BY i.name, i.variant ORDER BY qty DESC, revenue DESC LIMIT 10`).all(s, e);
  const itemsSold = db.prepare(`SELECT COALESCE(SUM(i.qty),0) n FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.created_at>=? AND o.created_at<? AND i.status!='voided' AND o.status!='cancelled'`).get(s, e).n;
  const voids = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(price*qty),0) value FROM order_items WHERE status='voided' AND void_at>=? AND void_at<?`).get(s, e);
  const pending = db.prepare("SELECT COUNT(*) c FROM order_items WHERE status='void_requested'").get().c;
  return {
    date: dateStr,
    orders: { total: orders.total || 0, dine_in: orders.dine_in || 0, takeaway: orders.takeaway || 0, open: orders.open || 0, paid: orders.paid || 0, cancelled },
    sales: { ...sales, avg_bill: sales.bills ? Math.round(sales.total / sales.bills) : 0 },
    hourly, top_items: top, items_sold: itemsSold, voids: { ...voids, pending },
  };
}
app.get('/api/stats', need('owner'), h((req, res) => res.json(dayStats(req.query.date || localDate(Date.now())))));
app.get('/api/stats/range', need('owner'), h((req, res) => {
  const days = Math.max(1, Math.min(int(req.query.days) || 14, 90));
  const offs = TZ_MIN * 60;
  const today = localDate(Date.now());
  const [todayStart] = dayRange(today);
  const from = todayStart - (days - 1) * 86400000;
  const o = db.prepare(`SELECT date(created_at/1000+?, 'unixepoch') d, COUNT(*) orders FROM orders
    WHERE created_at>=? AND status!='cancelled' GROUP BY d`).all(offs, from);
  const s = db.prepare(`SELECT date(paid_at/1000+?, 'unixepoch') d, SUM(total) sales FROM orders
    WHERE status='paid' AND paid_at>=? GROUP BY d`).all(offs, from);
  const map = {};
  for (let i = 0; i < days; i++) { const d = localDate(from + i * 86400000 + 3600000); map[d] = { date: d, orders: 0, sales: 0 }; }
  o.forEach(r => { if (map[r.d]) map[r.d].orders = r.orders; });
  s.forEach(r => { if (map[r.d]) map[r.d].sales = r.sales; });
  res.json(Object.values(map));
}));

app.get('/api/export.csv', need('owner'), h((req, res) => {
  const from = req.query.from || localDate(Date.now()), to = req.query.to || from;
  const [s] = dayRange(from), [, e] = dayRange(to);
  const rows = db.prepare('SELECT id FROM orders WHERE created_at>=? AND created_at<? ORDER BY created_at').all(s, e);
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['Date', 'Time', 'Order of the day', 'Bill no', 'Type', 'Table', 'Status', 'Items', 'Subtotal', 'Discount', 'Tax', 'Total', 'Payment'].join(',')];
  for (const r of rows) {
    const o = loadOrder(r.id);
    const when = new Date(o.created_at + TZ_MIN * 60000).toISOString();
    const items = o.items.filter(i => i.status !== 'voided').map(i => `${i.qty} x ${i.name}${i.variant ? ' (' + i.variant + ')' : ''}`).join('; ');
    lines.push([when.slice(0, 10), when.slice(11, 16), o.day_no, o.bill_no || '', o.type, o.table_no || '', o.status, items,
      o.status === 'paid' ? o.subtotal : o.running_total, o.discount, o.tax, o.total, o.pay_mode === 'split' ? `cash ${o.pay_cash} + online ${o.pay_online}` : (o.pay_mode || '')].map(q).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${from}-to-${to}.csv"` });
  res.send('﻿' + lines.join('\n'));
}));

// ---------- pages ----------
const view = f => path.join(__dirname, 'views', f);
const sendView = (res, f, extra) => {
  res.set('Cache-Control', 'no-cache');
  let html = fs.readFileSync(view(f), 'utf8')
    .replace(/\{\{v\}\}/g, BUILD).replace(/\{\{look\}\}/g, LOOK).replace(/\{\{theme\}\}/g, THEME)
    .replace(/\{\{name\}\}/g, RESTAURANT).replace(/\{\{phone\}\}/g, PHONE);
  for (const [k, v] of Object.entries(extra || {})) html = html.split('{{' + k + '}}').join(v);
  res.type('html').send(html);
};
const homeFor = role => role === 'waiter' ? '/waiter' : role === 'kitchen' ? '/kitchen' : role === 'counter' ? '/counter' : '/owner';
const page = (roles, file, door) => (req, res) => {
  const role = sessionRole(req);
  if (!role) return res.redirect('/login?as=' + door);
  if (!roles.includes(role)) return res.redirect(homeFor(role));
  sendView(res, file);
};
// the front page: three doors. Someone who is already signed in goes straight to their own screen.
app.get('/', (req, res) => {
  const role = sessionRole(req);
  if (role && req.query.choose === undefined) return res.redirect(homeFor(role));
  sendView(res, 'home.html');
});
app.get('/login', (req, res) => sendView(res, 'login.html'));
app.get('/menu', (req, res) => sendView(res, 'menu.html'));
// printable QR codes, one per table, that open the customer menu
app.get('/owner/qr', need('owner'), async (req, res) => {
  let base = String(req.query.base || process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s<>"']+$/.test(base)) base = req.protocol + '://' + req.get('host');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cards = [];
  for (let t = 0; t <= TABLES; t++) {
    const url = base + '/menu' + (t ? '?table=' + t : '');
    const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
    cards.push(`<div class="qc"><div class="lg" role="img" aria-label="${esc(RESTAURANT)}"></div><div class="tn">${t ? 'Table ' + t : 'Menu'}</div><div class="qr">${svg}</div><p class="hi">मेन्यू देखने के लिए स्कैन करें</p><p class="en">Scan to see our menu</p></div>`);
  }
  const local = /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.\d+\.\d+/.test(base);
  sendView(res, 'qr.html', { cards: cards.join(''), base: esc(base), warn: local ? '<div class="banner">These codes point to <b>' + esc(base) + '</b>, which only works on your own network. Print them from your live Railway address, or open this page with ?base=https://your-live-address</div>' : '' });
});
app.get('/waiter', page(['waiter', 'counter', 'owner'], 'waiter.html', 'waiter'));
app.get('/kitchen', page(['kitchen', 'counter', 'owner'], 'kitchen.html', 'kitchen'));
app.get('/counter', page(['counter', 'owner'], 'counter.html', 'admin'));
app.get('/owner', page(['owner'], 'owner.html', 'admin'));
app.use('/assets/fonts', express.static(path.join(__dirname, 'public', 'assets', 'fonts'), { maxAge: '30d', immutable: true }));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: 0 })); // always re-checked, so an update shows up at once

app.listen(PORT, () => {
  console.log(`${RESTAURANT} running on port ${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  if (DEFAULT_PINS) console.warn('WARNING: using default PINs (waiter 1111, counter 2222, kitchen 3333, owner 9999). Set WAITER_PIN, COUNTER_PIN, KITCHEN_PIN and OWNER_PIN before real use.');
});
