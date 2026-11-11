// Direct printing to a small thermal receipt printer (Bluetooth or USB) from Chrome / Edge.
// The ticket is drawn as a picture and sent as a bitmap, so Hindi prints correctly even though
// these printers have no Hindi font of their own.
const PRINTER = (() => {
  let mode = null;            // 'ble' | 'serial' | null
  let name = '';
  let port = null, writer = null;          // serial
  let device = null, chr = null;           // bluetooth low energy
  let dots = 384;                          // 58mm paper = 384 dots, 80mm paper = 576 dots
  try { dots = Number(localStorage.getItem('printDots')) || 384; } catch (e) {}
  let wm = 0.2;                            // logo strength behind bills: 0 = off, 0.2 light (default), 0.3 medium, 0.5 strong
  try { const v = localStorage.getItem('billLogo'); if (v !== null) wm = Number(v); } catch (e) {}
  let logoImg = null;
  let queue = Promise.resolve();
  const listeners = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const notify = () => listeners.forEach(f => { try { f(); } catch (e) {} });

  // Chrome only lets a page talk to Bluetooth services it names up front, so we name every one
  // that small receipt printers are known to use. A service ID you add in the printer menu is added to this list.
  const BASE = s => `0000${s}-0000-1000-8000-00805f9b34fb`;
  const KNOWN = ['18f0', 'ff00', 'ffe0', 'fff0', 'fee7', 'ae30', 'ae00', 'af30', 'ffe5', 'ff10', 'fd00', '1101'].map(BASE)
    .concat(['e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455']);
  const normUuid = v => {
    v = String(v || '').trim().toLowerCase().replace(/^0x/, '');
    if (/^[0-9a-f]{4}$/.test(v)) return BASE(v);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v;
    return null;
  };
  let extra = [];
  try { extra = JSON.parse(localStorage.getItem('printerServiceIds') || '[]').filter(normUuid); } catch (e) {}
  const services = () => [...new Set([...KNOWN, ...extra])];
  const errText = e => (e && e.name && e.name !== 'Error' ? e.name + ': ' : '') + ((e && e.message) || String(e));
  const isCancel = e => !!e && e.name === 'NotFoundError' && /cancel/i.test(e.message || ''); // you closed Chrome's device picker
  function needSecure(what) {
    if (window.isSecureContext === false) throw new Error(what + ' only works when this page is opened as http://localhost:3000 on this laptop, or from your https address. It does not work from an address like http://192.168.x.x.');
  }

  // ---------- connecting ----------
  const writable = c => c.properties.write || c.properties.writeWithoutResponse;
  async function findChar(server) {
    for (const uuid of services()) {                       // 1) try each known printer service one at a time
      try {
        const s = await server.getPrimaryService(uuid);
        for (const c of await s.getCharacteristics()) if (writable(c)) return c;
      } catch (e) { /* this printer does not have that service */ }
    }
    const seen = [];                                       // 2) otherwise look at whatever Chrome lets us see
    try {
      for (const s of await server.getPrimaryServices()) {
        seen.push(s.uuid);
        for (const c of await s.getCharacteristics()) if (writable(c)) return c;
      }
    } catch (e) { seen.push('(' + errText(e) + ')'); }
    const err = new Error('The printer connected, but I could not find where to send the print data. ' +
      (seen.length ? 'Services seen: ' + seen.join(', ') + '. ' : 'It showed no services I am allowed to use. ') +
      'Next step: try the COM port / USB option, or add this printer\'s service ID.');
    err.name = 'PrinterChannelError';
    throw err;
  }
  async function gattConnect(dev) {                        // the first try often fails while the printer wakes up
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await dev.gatt.connect(); }
      catch (e) { last = e; try { dev.gatt.disconnect(); } catch (x) {} await sleep(700); }
    }
    throw last;
  }
  const onGattDrop = () => { mode = null; notify(); };
  async function connectBle() {
    needSecure('Bluetooth printing');
    if (!navigator.bluetooth) throw new Error('This browser does not support Bluetooth printing. Use Chrome or Edge on the laptop.');
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: services() });
    device.addEventListener('gattserverdisconnected', onGattDrop);
    chr = await findChar(await gattConnect(device));
    mode = 'ble'; name = device.name || 'Bluetooth printer'; notify();
  }
  async function openPort(p) {
    await p.open({ baudRate: 115200 });
    writer = p.writable.getWriter(); port = p; mode = 'serial'; name = 'COM / USB printer'; notify();
  }
  async function connectSerial() {
    needSecure('COM port printing');
    if (!navigator.serial) throw new Error('This browser does not support COM port printing. Use Chrome or Edge on the laptop.');
    await openPort(await navigator.serial.requestPort());
  }
  async function autoReconnect() { // serial ports remember permission; Bluetooth needs one tap per session
    try { if (navigator.serial) { const ps = await navigator.serial.getPorts(); if (ps.length) await openPort(ps[0]); } } catch (e) {}
    // Bluetooth: newer Chrome can remember a printer you already picked, so a reload may reconnect without a tap
    try {
      if (!mode && navigator.bluetooth && navigator.bluetooth.getDevices) {
        const d = (await navigator.bluetooth.getDevices())[0];
        if (d) {
          d.removeEventListener('gattserverdisconnected', onGattDrop); d.addEventListener('gattserverdisconnected', onGattDrop);
          chr = await findChar(await gattConnect(d));
          device = d; mode = 'ble'; name = d.name || 'Bluetooth printer'; notify();
        }
      }
    } catch (e) { try { if (!mode) chr = null; } catch (x) {} }
  }
  async function disconnect() {
    try { if (writer) { writer.releaseLock(); await port.close(); } } catch (e) {}
    try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
    mode = null; writer = null; port = null; chr = null; notify();
  }
  async function ensureLink() {
    if (mode === 'ble' && !device.gatt.connected) chr = await findChar(await gattConnect(device));
  }

  async function writeBytes(bytes) {
    if (mode === 'serial') {
      for (let i = 0; i < bytes.length; i += 512) { await writer.write(bytes.slice(i, i + 512)); await sleep(25); }
    } else if (mode === 'ble') {
      for (let i = 0; i < bytes.length; i += 100) {
        const part = bytes.slice(i, i + 100);
        if (chr.properties.writeWithoutResponse) await chr.writeValueWithoutResponse(part); else await chr.writeValue(part);
        await sleep(20);
      }
    } else throw new Error('Printer not connected');
  }

  // ---------- turning a ticket into printer bytes ----------
  const CSS = `.t{font-size:22px;line-height:1.3;padding:4px 2px;color:#000;background:#fff;font-family:"Noto Sans Devanagari","Nirmala UI","Mangal","Segoe UI",Arial,sans-serif}
    .c{text-align:center}.big{font-size:34px;font-weight:700}.mid{font-size:28px}.b{font-weight:700}
    hr{border:0;border-top:2px dashed #000;margin:8px 0}.it{margin:8px 0}.it .h{font-size:28px;font-weight:700}.it small{display:block;font-size:19px}
    table{width:100%;border-collapse:collapse}td{padding:3px 0;vertical-align:top}td.r{text-align:right;white-space:nowrap}.tot td{font-weight:700;font-size:26px}`;

  async function bitmap(html, opts) {
    opts = opts || {};
    const W = dots;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0'; // keeps it off-screen while we measure it
    host.innerHTML = `<div id="__tk" style="width:${W}px;background:#fff"><style>${CSS}</style><div class="t">${html}</div></div>`;
    document.body.appendChild(host);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const inner = host.firstElementChild; // serialise this one, without the off-screen positioning
      const H = Math.ceil(inner.getBoundingClientRect().height) + 6;
      const xml = new XMLSerializer().serializeToString(inner);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xml}</foreignObject></svg>`;
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, W, H).data;
      const rowBytes = W / 8, data = new Uint8Array(rowBytes * H);
      const isText = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 150) { isText[y * W + x] = 1; data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7); }
      }
      // faint logo behind the text. A thermal printer only has black dots, so "transparency" is a
      // sparse dot pattern (ordered dithering): wm = share of dots switched on inside solid logo areas.
      if (opts.watermark && wm > 0) {
        if (!logoImg) { logoImg = new Image(); logoImg.src = '/assets/brand/logo-green.png'; await logoImg.decode(); }
        // one logo, centred on the bill; on a short bill it shrinks so the whole logo still fits
        const ratio = logoImg.height / logoImg.width;
        const lw = Math.min(W - 16, Math.round((H - 16) / ratio)), lh = Math.round(lw * ratio);
        const wc = document.createElement('canvas'); wc.width = W; wc.height = H;
        const wx = wc.getContext('2d'); wx.imageSmoothingQuality = 'high';
        wx.drawImage(logoImg, Math.round((W - lw) / 2), Math.round((H - lh) / 2), lw, lh);
        const a = wx.getImageData(0, 0, W, H).data;
        const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const k = y * W + x;
          if (isText[k]) continue;
          // keep a one-dot clear margin around every letter so small print stays readable
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W && isText[yy * W + xx]) { near = true; break; }
          }
          if (near) continue;
          if (a[k * 4 + 3] / 255 * wm > (bayer[y & 3][x & 3] + 0.5) / 16) data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      return { W, H, rowBytes, data };
    } finally { host.remove(); }
  }
  function escpos(b, feed) {
    const parts = [Uint8Array.of(0x1B, 0x40)]; // initialise
    for (let y = 0; y < b.H; y += 200) {         // GS v 0 raster image, in bands of 200 rows
      const n = Math.min(200, b.H - y);
      parts.push(Uint8Array.of(0x1D, 0x76, 0x30, 0x00, b.rowBytes & 255, b.rowBytes >> 8, n & 255, n >> 8));
      parts.push(b.data.subarray(y * b.rowBytes, (y + n) * b.rowBytes));
    }
    parts.push(Uint8Array.of(0x1B, 0x64, feed == null ? 4 : feed)); // feed a few lines so the ticket clears the tear bar
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; });
    return out;
  }

  function print(html, opts) {
    queue = queue.then(async () => {
      await ensureLink();
      await writeBytes(escpos(await bitmap(html, opts), opts && opts.feed));
    });
    const mine = queue;
    queue = queue.catch(() => {}); // one failed print must not block the next ones
    return mine;
  }
  const test = () => print(`<div class="c big">TEST PRINT</div><div class="c mid">टेस्ट प्रिंट</div><hr>
    <div class="it"><span class="h">2 × बटर चिकन (फुल)</span><small>Butter Chicken – Full</small></div>
    <div class="it"><span class="h">4 × बटर नान</span><small>Butter Naan</small></div><hr>
    <div class="c">If you can read this, printing works ✔<br>अगर यह पढ़ पा रहे हैं तो प्रिंटिंग ठीक है</div>`);

  return {
    connectBle, connectSerial, autoReconnect, disconnect, print, test, bitmap, errText, isCancel,
    addServiceId(v) { const u = normUuid(v); if (!u) throw new Error('That is not a Bluetooth service ID. Use 4 characters like ffe0, or the long form with dashes.'); if (!extra.includes(u)) { extra.push(u); try { localStorage.setItem('printerServiceIds', JSON.stringify(extra)); } catch (e) {} } return u; },
    get connected() { return !!mode; }, get name() { return name; }, get mode() { return mode; }, get dots() { return dots; }, get billLogo() { return wm; },
    setDots(n) { dots = n; try { localStorage.setItem('printDots', String(n)); } catch (e) {} notify(); },
    setBillLogo(v) { wm = v; try { localStorage.setItem('billLogo', String(v)); } catch (e) {} notify(); },
    onChange(f) { listeners.push(f); },
  };
})();
