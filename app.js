/**
 * WA Checker v15 — minimal memory, fast QR, robust disconnect detection
 */

process.on('uncaughtException',  e => console.error('[CRASH]', e.message));
process.on('unhandledRejection', r => console.error('[REJECT]', r?.message || r));

const express  = require('express');
const http     = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode   = require('qrcode');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MAX_ACCOUNTS = 5;
const SESSION_DIR  = path.resolve(__dirname, '.wa-session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const accounts    = new Map();   // id → acc
let   createQueue = [];          // serial queue: only 1 browser launching at a time
let   creating    = false;

function nextFreeId() {
  for (let i = 1; i <= MAX_ACCOUNTS; i++) if (!accounts.has(i)) return i;
  return null;
}

let isChecking = false;
let results    = [];
let stats      = { valid: 0, invalid: 0, total: 0 };

// ── Country lookup ───────────────────────────────────────────────────────
const CC_TO_ISO = {
  '1':'US','7':'RU','20':'EG','27':'ZA','30':'GR','31':'NL','32':'BE','33':'FR',
  '34':'ES','36':'HU','39':'IT','40':'RO','41':'CH','43':'AT','44':'GB','45':'DK',
  '46':'SE','47':'NO','48':'PL','49':'DE','51':'PE','52':'MX','54':'AR','55':'BR',
  '56':'CL','57':'CO','58':'VE','60':'MY','61':'AU','62':'ID','63':'PH','64':'NZ',
  '65':'SG','66':'TH','81':'JP','82':'KR','84':'VN','86':'CN','90':'TR','91':'IN',
  '92':'PK','93':'AF','94':'LK','95':'MM','98':'IR',
  '212':'MA','213':'DZ','216':'TN','218':'LY','220':'GM','221':'SN','222':'MR',
  '223':'ML','224':'GN','225':'CI','226':'BF','227':'NE','228':'TG','229':'BJ',
  '230':'MU','231':'LR','232':'SL','233':'GH','234':'NG','235':'TD','236':'CF',
  '237':'CM','238':'CV','239':'ST','240':'GQ','241':'GA','242':'CG','243':'CD',
  '244':'AO','245':'GW','248':'SC','249':'SD','250':'RW','251':'ET','252':'SO',
  '253':'DJ','254':'KE','255':'TZ','256':'UG','257':'BI','258':'MZ','260':'ZM',
  '261':'MG','263':'ZW','264':'NA','265':'MW','266':'LS','267':'BW','268':'SZ',
  '269':'KM','291':'ER',
  '350':'GI','351':'PT','352':'LU','353':'IE','354':'IS','355':'AL','356':'MT',
  '357':'CY','358':'FI','359':'BG','370':'LT','371':'LV','372':'EE','373':'MD',
  '374':'AM','375':'BY','376':'AD','377':'MC','378':'SM','380':'UA','381':'RS',
  '382':'ME','385':'HR','386':'SI','387':'BA','389':'MK',
  '420':'CZ','421':'SK','423':'LI',
  '501':'BZ','502':'GT','503':'SV','504':'HN','505':'NI','506':'CR','507':'PA',
  '509':'HT','591':'BO','592':'GY','593':'EC','595':'PY','597':'SR','598':'UY',
  '670':'TL','673':'BN','674':'NR','675':'PG','676':'TO','677':'SB','678':'VU',
  '679':'FJ','680':'PW','685':'WS','686':'KI','691':'FM','692':'MH','850':'KP',
  '852':'HK','853':'MO','855':'KH','856':'LA','880':'BD',
  '960':'MV','961':'LB','962':'JO','963':'SY','964':'IQ','965':'KW','966':'SA',
  '967':'YE','968':'OM','970':'PS','971':'AE','972':'IL','973':'BH','974':'QA',
  '975':'BT','976':'MN','977':'NP','992':'TJ','993':'TM','994':'AZ','995':'GE',
  '996':'KG','998':'UZ',
};
function getCountryInfo(e164) {
  const d = (e164 || '').replace('+', '');
  for (let l = 4; l >= 1; l--) {
    const p = d.slice(0, l);
    if (CC_TO_ISO[p]) return { iso: CC_TO_ISO[p], code: p };
  }
  return { iso: null, code: null };
}

// ── Chrome finder ────────────────────────────────────────────────────────
let _chromePath = null;
function findChrome() {
  if (_chromePath) return _chromePath;
  const candidates = [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    (() => { try { return require('puppeteer').executablePath(); } catch { return null; } })(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) { _chromePath = p; return p; } } catch {}
  }
  try {
    const { execSync } = require('child_process');
    const cmd = process.platform === 'win32'
      ? 'where chrome 2>nul || where msedge 2>nul'
      : 'which google-chrome-stable 2>/dev/null || which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null || which chromium 2>/dev/null';
    const p = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).split('\n')[0].trim();
    if (p && fs.existsSync(p)) { _chromePath = p; return p; }
  } catch {}
  return null;
}

// ── Broadcast ────────────────────────────────────────────────────────────
function broadcast() {
  const list = Array.from(accounts.values()).map(a => ({
    id: a.id, label: a.label, state: a.state,
    loadingPct: a.loadingPct ?? null, qr: a.qr ?? null,
    profileName: a.profileName ?? null, profilePic: a.profilePic ?? null,
  }));
  io.emit('accounts', list);
  io.emit('ready_count', { count: list.filter(a => a.state === 'ready').length });
}

// ── Session helpers ──────────────────────────────────────────────────────
function deleteSession(id) {
  try {
    const sp = path.join(SESSION_DIR, `session-wa-account-${id}`);
    if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
  } catch {}
}

// Safe client destroy — suppresses "Target closed" errors
async function safeDestroy(client, timeout = 8000) {
  if (!client) return;
  try { client.removeAllListeners(); } catch {}
  try {
    await Promise.race([
      client.destroy().catch(() => {}),
      new Promise(r => setTimeout(r, timeout)),
    ]);
  } catch {}
}

// ── Serial creation queue ─────────────────────────────────────────────────
// Ensures only one Chrome browser launches at a time → prevents OOM crashes
function enqueueCreate(id) {
  if (createQueue.includes(id) || accounts.has(id)) return;
  createQueue.push(id);
  processQueue_create();
}

async function processQueue_create() {
  if (creating || createQueue.length === 0) return;
  creating = true;
  const id = createQueue.shift();
  try {
    await doCreateAccount(id);
  } catch (e) {
    console.error(`[Account ${id}] create error:`, e.message);
  }
  creating = false;
  // Allow 1s between browser launches
  if (createQueue.length > 0) setTimeout(processQueue_create, 1000);
}

async function doCreateAccount(id) {
  if (accounts.has(id)) return;
  const chromePath = findChrome();
  if (!chromePath) {
    io.emit('toast', { msg: 'Chrome not found', type: 'err' });
    return;
  }

  // Clean up any leftover chrome tmp dir from a previous crash
  try { fs.rmSync(`/tmp/chrome-wa-${id}`, { recursive: true, force: true }); } catch {}

  const acc = {
    id, label: `Account ${id}`,
    client: null, state: 'init', qr: null, loadingPct: null,
    profileName: null, profilePic: null, dead: false,
  };
  accounts.set(id, acc);
  broadcast();

  // Minimal Chromium flags for low-memory machines
  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',       // use /tmp instead of /dev/shm
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',              // ← key for minimal memory: one process
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-web-resources',
    '--hide-scrollbars',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--ignore-certificate-errors',
    '--disable-features=VizDisplayCompositor,TranslateUI,BlinkGenPropertyTrees',
    '--memory-pressure-off',
    `--user-data-dir=/tmp/chrome-wa-${id}`,
  ];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `wa-account-${id}`, dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      executablePath: chromePath,
      timeout: 0,          // disable puppeteer's own timeout — we handle it ourselves
      args: puppeteerArgs,
    },
    // Faster: skip loading extra WA web resources we don't need
    webVersionCache: { type: 'local', path: path.join(SESSION_DIR, 'waweb-cache') },
  });

  acc.client = client;

  // Guard: mark dead and skip if client was replaced
  const guard = () => acc.client === client && !acc.dead;

  client.on('qr', async (qr) => {
    if (!guard()) return;
    try {
      acc.qr    = await qrcode.toDataURL(qr, { width: 256, margin: 2, errorCorrectionLevel: 'L' });
      acc.state = 'qr';
      acc.loadingPct = null;
      broadcast();
    } catch {}
  });

  client.on('authenticated', () => {
    if (!guard()) return;
    acc.state = 'authenticated'; acc.qr = null; acc.loadingPct = 0;
    broadcast();
  });

  client.on('loading_screen', (pct) => {
    if (!guard()) return;
    acc.state = 'loading'; acc.loadingPct = pct;
    broadcast();
  });

  client.on('ready', async () => {
    if (!guard()) return;
    acc.state = 'ready'; acc.qr = null; acc.loadingPct = null;

    // Grab profile info — all wrapped so any failure doesn't block 'ready'
    try { acc.profileName = client.info?.pushname || client.info?.me?.user || null; } catch {}

    // Fetch profile picture with retries
    try {
      const wid = client.info?.me?.user ? client.info.me.user + '@c.us' : null;
      if (wid) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const pic = await client.getProfilePicUrl(wid);
            if (pic) { acc.profilePic = pic; break; }
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch {}

    broadcast();
    io.emit('toast', { msg: `Account ${id} connected ✓`, type: 'ok' });
  });

  client.on('auth_failure', async () => {
    if (!guard()) return;
    console.error(`[Account ${id}] Auth failure`);
    acc.state = 'error'; acc.dead = true;
    broadcast();
    deleteSession(id);
    await safeDestroy(client);
    acc.client = null;
  });

  // disconnected fires when WA server ends the session (phone logout, ban, etc.)
  client.on('disconnected', async (reason) => {
    if (!guard()) return;
    console.log(`[Account ${id}] Disconnected: ${reason}`);
    acc.state = 'disconnected'; acc.loadingPct = null; acc.dead = true;
    broadcast();
    io.emit('toast', { msg: `Account ${id} disconnected`, type: 'err' });
    if (reason === 'LOGOUT') deleteSession(id);
    // Destroy the browser in background — don't block the event loop
    const c = acc.client; acc.client = null;
    setTimeout(() => safeDestroy(c), 500);
    try { fs.rmSync(`/tmp/chrome-wa-${id}`, { recursive: true, force: true }); } catch {}
  });

  // Init — catch "Target closed" and other puppeteer errors gracefully
  client.initialize().catch(async (err) => {
    if (!guard()) return;
    const msg = err?.message || String(err);
    console.error(`[Account ${id}] Init error: ${msg}`);
    acc.dead = true;

    if (msg.includes('already running') || msg.includes('userDataDir')) {
      acc.state = 'error'; broadcast();
      accounts.delete(id);
      try { fs.rmSync(`/tmp/chrome-wa-${id}`, { recursive: true, force: true }); } catch {}
      // Retry after cleanup
      setTimeout(() => enqueueCreate(id), 4000);
      return;
    }
    acc.state = 'error'; broadcast();
    await safeDestroy(client);
    acc.client = null;
  });
}

// ── Logout ────────────────────────────────────────────────────────────────
async function logoutAccount(id) {
  const acc = accounts.get(id);
  if (!acc || acc.state === 'removing') return;
  acc.state = 'removing'; acc.dead = true; broadcast();

  const client = acc.client; acc.client = null;
  if (client) {
    // logout() must fire BEFORE destroy() so WA servers get the signal
    try { await Promise.race([client.logout(), new Promise(r => setTimeout(r, 10000))]); } catch {}
    await safeDestroy(client, 6000);
  }

  deleteSession(id);
  try { fs.rmSync(`/tmp/chrome-wa-${id}`, { recursive: true, force: true }); } catch {}
  accounts.delete(id);
  broadcast();
  io.emit('toast', { msg: `Account ${id} logged out`, type: 'ok' });
}

// ── Helpers ──────────────────────────────────────────────────────────────
function getReadyClient() {
  for (const acc of accounts.values()) {
    if (acc.state === 'ready' && acc.client && !acc.dead) return acc.client;
  }
  return null;
}

function safeCall(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

// ── Number checker ────────────────────────────────────────────────────────
async function checkNumber(raw, acc) {
  const cleaned = raw.replace(/\D/g, '').replace(/^0+/, '');
  if (cleaned.length < 7 || cleaned.length > 15)
    return { number: raw, cleaned, registered: false, error: 'Invalid length', account: acc.label };
  try {
    const wid = cleaned + '@c.us';
    const registered = await acc.client.isRegisteredUser(wid);
    if (!registered)
      return { number: raw, cleaned, e164: '+' + cleaned, registered: false, account: acc.label };

    const [picRes, contactRes] = await Promise.allSettled([
      acc.client.getProfilePicUrl(wid).catch(() => null),
      acc.client.getContactById(wid).catch(() => null),
    ]);
    const pic         = picRes.value  || null;
    const contact     = contactRes.value || null;
    const countryInfo = getCountryInfo('+' + cleaned);
    let   accountType = 'personal';
    if (contact?.isEnterprise) accountType = 'enterprise';
    else if (contact?.isBusiness) accountType = 'business';

    return {
      number: raw, cleaned, e164: '+' + cleaned, registered: true,
      waLink: `https://wa.me/${cleaned}`,
      profilePic: pic,
      isBusiness: contact?.isBusiness ?? false,
      isEnterprise: contact?.isEnterprise ?? false,
      accountType,
      name:   contact?.pushname || contact?.name || null,
      status: contact?.statusMessage || contact?.about || null,
      country: countryInfo.iso, countryCode: countryInfo.code,
      checkedAt: new Date().toISOString(), account: acc.label,
    };
  } catch (err) {
    return { number: raw, cleaned, e164: '+' + cleaned, registered: false, error: err.message, account: acc.label };
  }
}

// ── Queue checker ─────────────────────────────────────────────────────────
async function processQueue(numbers) {
  if (isChecking) return;
  const ready = Array.from(accounts.values()).filter(a => a.state === 'ready' && a.client && !a.dead);
  if (!ready.length) { io.emit('error_msg', { message: 'No connected accounts.' }); return; }
  isChecking = true; results = []; stats = { valid: 0, invalid: 0, total: numbers.length };
  let rrIndex = 0;
  const delay = Math.max(400, Math.floor(1200 / ready.length));
  for (let i = 0; i < numbers.length; i++) {
    if (!isChecking) break;
    const num = numbers[i].trim(); if (!num) continue;
    io.emit('progress', { current: i+1, total: numbers.length, percent: Math.round(((i+1)/numbers.length)*100) });
    let acc = null;
    for (let t = 0; t < ready.length; t++) {
      const c = ready[rrIndex % ready.length]; rrIndex++;
      if (c?.state === 'ready' && c.client && !c.dead) { acc = c; break; }
    }
    if (!acc) {
      const r = { number: num, registered: false, error: 'No ready account', account: '—' };
      results.push(r); stats.invalid++; io.emit('result', { result: r, index: i, stats }); continue;
    }
    const result = await checkNumber(num, acc);
    results.push(result);
    if (result.registered) stats.valid++; else stats.invalid++;
    io.emit('result', { result, index: i, stats });
    if (i < numbers.length - 1 && isChecking) await new Promise(r => setTimeout(r, delay));
  }
  isChecking = false; io.emit('done', { results, stats });
}

async function sendMessage(numbers, message) {
  const client = getReadyClient();
  if (!client) return { error: 'No connected account', sent: 0, failed: numbers.length };
  const sent = [], failed = [];
  for (const num of numbers) {
    const cleaned = num.replace(/\D/g, '').replace(/^0+/, '');
    if (!cleaned) continue;
    try {
      await client.sendMessage(cleaned + '@c.us', message);
      sent.push(num);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) { failed.push({ number: num, error: err.message }); }
  }
  return { sent: sent.length, failed: failed.length, errors: failed };
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/status', (req, res) => res.json({ ok: true, accounts: accounts.size }));

// Proxy WhatsApp CDN profile pictures to avoid browser CORS blocks
app.get('/proxy-pic', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://')) return res.status(400).end();
  try {
    const https = require('https');
    const request = https.get(url, { timeout: 8000 }, (imgRes) => {
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      imgRes.pipe(res);
    });
    request.on('error', () => res.status(502).end());
    request.on('timeout', () => { request.destroy(); res.status(504).end(); });
  } catch { res.status(500).end(); }
});

app.get('/export/csv', (req, res) => {
  if (!results.length) return res.status(404).json({ error: 'No results' });
  const rows = ['Number,E164,On WhatsApp,Type,Name,Status,Country,WA Link,Account,Checked At',
    ...results.map(r => [r.number, r.e164||'', r.registered?'YES':'NO',
      r.accountType||'', r.name||'', r.status||'', r.country||'',
      r.waLink||'', r.account||'', r.checkedAt||'']
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wa_results.csv"');
  res.send(rows);
});

app.get('/export/txt', (req, res) => {
  const valid = results.filter(r => r.registered);
  if (!valid.length) return res.status(404).json({ error: 'No valid numbers' });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="valid_numbers.txt"');
  res.send(valid.map(r => r.e164 || ('+' + r.cleaned)).join('\n'));
});

app.post('/send', async (req, res) => {
  const { numbers, message } = req.body;
  if (!numbers?.length || !message?.trim()) return res.status(400).json({ error: 'Missing params' });
  res.json(await sendMessage(numbers, message));
});

// ── Sockets ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  broadcast();   // send current state immediately on connect

  socket.on('add_account', () => {
    if (accounts.size >= MAX_ACCOUNTS)
      return socket.emit('toast', { msg: `Max ${MAX_ACCOUNTS} accounts`, type: 'err' });
    const id = nextFreeId();
    if (!id) return;
    enqueueCreate(id);
  });

  socket.on('logout_account', async ({ id }) => {
    await logoutAccount(parseInt(id));
  });

  socket.on('restart_account', async ({ id }) => {
    const numId = parseInt(id);
    const acc   = accounts.get(numId);
    if (!acc) return;
    acc.state = 'init'; acc.dead = true; broadcast();
    const client = acc.client; acc.client = null;
    accounts.delete(numId);
    await safeDestroy(client, 5000);
    try { fs.rmSync(`/tmp/chrome-wa-${numId}`, { recursive: true, force: true }); } catch {}
    setTimeout(() => enqueueCreate(numId), 1500);
  });

  socket.on('update_profile', async ({ id, name, picBase64 }) => {
    const numId = parseInt(id);
    const acc   = accounts.get(numId);
    if (!acc || acc.state !== 'ready' || !acc.client || acc.dead)
      return socket.emit('toast', { msg: 'Account not ready', type: 'err' });

    const client = acc.client;
    let ok = false;

    // ── Update name ──
    if (name && name.trim()) {
      // Method 1: setDisplayName (changes WA profile name)
      try { await client.setDisplayName(name.trim()); ok = true; } catch {}
      // Method 2: evaluate directly in WA web page (most reliable)
      try {
        await client.pupPage.evaluate(async (n) => {
          const Store = window.require('WAWebCollections');
          await Store?.ProfileSettings?.updateDisplayName?.(n);
        }, name.trim());
        ok = true;
      } catch {}
      acc.profileName = name.trim();
    }

    // ── Update picture ──
    if (picBase64) {
      const b64 = picBase64.replace(/^data:image\/\w+;base64,/, '');
      const media = new MessageMedia('image/jpeg', b64);
      try { await client.setProfilePicture(media); ok = true; } catch (e) {
        console.warn(`[Account ${numId}] setProfilePicture:`, e.message);
      }
      // Wait 2s for WA servers to process, then re-fetch URL
      await new Promise(r => setTimeout(r, 2000));
      try {
        const wid = client.info?.me?.user ? client.info.me.user + '@c.us' : null;
        if (wid) {
          const freshPic = await client.getProfilePicUrl(wid).catch(() => null);
          // freshPic might be the same URL but we use it; fallback to base64
          acc.profilePic = freshPic || picBase64;
        } else {
          acc.profilePic = picBase64;
        }
      } catch { acc.profilePic = picBase64; }
    }

    broadcast();
    socket.emit('toast', { msg: ok ? 'Profile updated!' : 'Saved locally (WA sync may take a moment)', type: 'ok' });
    socket.emit('profile_updated', { id: numId, profileName: acc.profileName, profilePic: acc.profilePic });
  });

  socket.on('check', ({ numbers }) => {
    if (!Array.from(accounts.values()).some(a => a.state === 'ready'))
      return socket.emit('error_msg', { message: 'No accounts connected.' });
    if (isChecking) return socket.emit('error_msg', { message: 'Already checking.' });
    if (!numbers?.length) return socket.emit('error_msg', { message: 'No numbers.' });
    processQueue(numbers);
  });

  socket.on('send_message', async ({ numbers, message }) => {
    if (!numbers?.length || !message?.trim())
      return socket.emit('toast', { msg: 'Numbers and message required', type: 'err' });
    const result = await sendMessage(numbers, message);
    socket.emit('send_done', result);
    socket.emit('toast', {
      msg: `Sent: ${result.sent}  Failed: ${result.failed}`,
      type: result.failed > 0 ? 'warn' : 'ok',
    });
  });

  socket.on('stop', () => { isChecking = false; io.emit('toast', { msg: 'Stopped', type: 'ok' }); });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nWA Checker v15 → http://localhost:${PORT}`);
  if (!findChrome()) console.error('[Chrome] NOT FOUND — install chromium or google-chrome');
  // Start account 1 after a short delay to let the HTTP server settle
  setTimeout(() => enqueueCreate(1), 500);
});

module.exports = app;
