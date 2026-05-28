// ─── Config ──────────────────────────────────────────────────────────────────
// Tokens are persisted in localStorage from the in-page Settings panel.
const CONFIG = {
  brandfetchClientId: localStorage.getItem('brandfetchClientId') || '',
  logoDevToken: localStorage.getItem('logoDevToken') || '',
  concurrency: 6,
  minBlobBytes: 200,
  // Final composite canvas dimensions
  canvas: {
    W: 1024,
    H: 256,
    iconBox: 200,
    pad: 28,
    maxFont: 130,
    minFont: 28,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  // Public CORS proxies, tried in order if direct fetch is blocked. These
  // all add Access-Control-Allow-Origin: * to whatever they relay, which
  // lets us read the image bytes back into a Blob.
  proxies: [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ],
  fetchTimeoutMs: 6000,
};

// AbortController wrapper so a hung CDN doesn't leave the whole batch
// spinning forever. Rejects with a normal Error so the caller's try/catch
// handles it the same as any other fetch failure.
function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.fetchTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Derive a simple-icons slug from a company name. Picks the parenthetical
// short name when present ("Alphabet (Google)" → "google"), strips diacritics
// and non-alphanumerics, and replaces special chars per simple-icons rules.
function deriveSlug(name) {
  if (!name) return '';
  const paren = name.match(/\(([^)]+)\)/);
  if (paren) name = paren[1];
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/\./g, 'dot')
    .replace(/[^a-z0-9]/g, '');
}

// ─── Source chain ────────────────────────────────────────────────────────────
// Each source.url takes a context object: { ticker, domain, name, slug }.
// SimpleIcons goes first because its CDN reliably sets CORS headers, so it
// works where everything else fails behind a strict firewall.
const SOURCES = [
  {
    name: 'SimpleIcons',
    enabled: () => true,
    url: ({ slug }) => (slug ? `https://cdn.simpleicons.org/${slug}` : null),
  },
  {
    name: 'Brandfetch',
    enabled: () => !!CONFIG.brandfetchClientId,
    url: ({ domain }) =>
      domain
        ? `https://cdn.brandfetch.io/${domain}/w/512/h/512/symbol?c=${encodeURIComponent(CONFIG.brandfetchClientId)}`
        : null,
  },
  {
    name: 'logo.dev',
    enabled: () => !!CONFIG.logoDevToken,
    url: ({ ticker, domain }) => {
      const key = encodeURIComponent(CONFIG.logoDevToken);
      if (ticker) return `https://img.logo.dev/ticker/${ticker}?token=${key}&format=png&retina=true`;
      if (domain) return `https://img.logo.dev/${domain}?token=${key}&format=png&retina=true`;
      return null;
    },
  },
  {
    name: 'Clearbit',
    enabled: () => true,
    url: ({ domain }) => (domain ? `https://logo.clearbit.com/${domain}` : null),
  },
  {
    name: 'DuckDuckGo',
    enabled: () => true,
    url: ({ domain }) => (domain ? `https://icons.duckduckgo.com/ip3/${domain}.ico` : null),
  },
  {
    name: 'Google',
    enabled: () => true,
    url: ({ domain }) =>
      domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=256` : null,
  },
];

// ─── State ───────────────────────────────────────────────────────────────────
let TICKER_MAP = {};
const cards = new Map();

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('data/tickers.json');
    TICKER_MAP = await res.json();
  } catch (err) {
    console.warn('Could not load tickers.json:', err);
    TICKER_MAP = {};
  }
  document.getElementById('fetch-btn').addEventListener('click', onFetchClicked);
  document.getElementById('zip-btn').addEventListener('click', onZipClicked);
  document.getElementById('tickers').addEventListener('keydown', (e) => {
    // Enter fetches; Shift+Enter inserts a newline if you're pasting a list.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onFetchClicked();
    }
  });

  document.getElementById('settings-toggle').addEventListener('click', () => {
    const s = document.getElementById('settings');
    s.open = !s.open;
  });
  document.getElementById('brandfetch-id').value = CONFIG.brandfetchClientId;
  document.getElementById('logodev-token').value = CONFIG.logoDevToken;
  document.getElementById('save-settings').addEventListener('click', () => {
    const bf = document.getElementById('brandfetch-id').value.trim();
    const ld = document.getElementById('logodev-token').value.trim();
    CONFIG.brandfetchClientId = bf;
    CONFIG.logoDevToken = ld;
    if (bf) localStorage.setItem('brandfetchClientId', bf);
    else localStorage.removeItem('brandfetchClientId');
    if (ld) localStorage.setItem('logoDevToken', ld);
    else localStorage.removeItem('logoDevToken');
    const status = document.getElementById('settings-status');
    status.textContent = 'Saved.';
    setTimeout(() => (status.textContent = ''), 1500);
  });
}

// ─── Input handling ──────────────────────────────────────────────────────────
function parseTickers(raw) {
  return [...new Set(
    raw.toUpperCase().split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
  )];
}

function onFetchClicked() {
  const tickers = parseTickers(document.getElementById('tickers').value);
  if (!tickers.length) { setStatus('Enter at least one ticker.'); return; }
  runFetch(tickers);
}

async function runFetch(tickers) {
  document.getElementById('fetch-btn').disabled = true;
  document.getElementById('zip-btn').disabled = true;
  setStatus(`Fetching ${tickers.length} logo${tickers.length === 1 ? '' : 's'}…`);

  const grid = document.getElementById('results');
  grid.innerHTML = '';
  cards.clear();

  for (const ticker of tickers) {
    const entry = TICKER_MAP[ticker] || {};
    const card = createCard(ticker, entry.name || ticker, entry.domain || '', entry.slug || '');
    cards.set(ticker, card);
    grid.appendChild(card.node);
  }

  let okCount = 0;
  await processWithConcurrency(tickers, async (ticker) => {
    const card = cards.get(ticker);
    const out = await buildLogo(card);
    card.attempts = out.log;
    if (out.blob) {
      okCount++;
      applyResult(card, out.blob, out.source);
    } else {
      applyError(card);
    }
  }, CONFIG.concurrency);

  let statusMsg = `Done. ${okCount}/${tickers.length} succeeded.`;
  if (okCount === 0) {
    // Surface the most useful failure reason inline so the user doesn't
    // have to expand a card to see why everything failed.
    const firstCard = [...cards.values()].find((c) => c.attempts.length > 0);
    if (firstCard) {
      const lastErr = firstCard.attempts[firstCard.attempts.length - 1];
      statusMsg += ` Last error: ${lastErr.source} ${lastErr.status} — ${lastErr.detail}`;
    }
  }
  setStatus(statusMsg);
  document.getElementById('fetch-btn').disabled = false;
  if (okCount > 0) document.getElementById('zip-btn').disabled = false;
}

async function processWithConcurrency(items, fn, max) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try { await fn(items[idx]); } catch (e) { console.error(e); }
    }
  });
  await Promise.all(workers);
}

// ─── Build pipeline: fetch icon → composite with name ────────────────────────
async function buildLogo(card) {
  const ctx = {
    ticker: card.ticker,
    domain: card.domain,
    name: card.name,
    slug: card.slug || deriveSlug(card.name || card.ticker),
  };
  const { result, log } = await fetchIcon(ctx);
  if (!result) return { blob: null, source: null, log };
  try {
    const iconImg = await blobToImage(result.blob);
    const color = extractDominantColor(iconImg);
    const composedBlob = await renderComposite(iconImg, card.name || card.ticker, color);
    return { blob: composedBlob, source: result.source, log };
  } catch (err) {
    log.push({ source: 'composite', status: 'error', detail: err.message || 'compose failed' });
    return { blob: null, source: null, log };
  }
}

async function fetchIcon(ctx) {
  const log = [];
  for (const source of SOURCES) {
    if (!source.enabled()) {
      log.push({ source: source.name, status: 'skipped', detail: 'not configured' });
      continue;
    }
    const url = source.url(ctx);
    if (!url) {
      log.push({ source: source.name, status: 'skipped', detail: 'no usable input' });
      continue;
    }

    // Try direct fetch first, then each CORS proxy. First success wins for
    // this source — if all fail, fall through to the next source.
    const attempts = [
      { label: 'direct', url },
      ...CONFIG.proxies.map((p, i) => ({ label: `proxy${i + 1}`, url: p(url) })),
    ];

    let gotBlob = null;
    let gotVia = null;
    for (const attempt of attempts) {
      try {
        const res = await fetchWithTimeout(attempt.url, { mode: 'cors', cache: 'no-store', redirect: 'follow' });
        if (!res.ok) {
          log.push({ source: source.name, status: `${attempt.label} http`, detail: `HTTP ${res.status}` });
          continue;
        }
        const ct = res.headers.get('content-type') || '';
        // Some proxies strip / lie about content-type — only reject if it's
        // explicitly text or json. Treat empty / octet-stream as maybe-image.
        if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
          log.push({ source: source.name, status: `${attempt.label} bad-type`, detail: ct });
          continue;
        }
        const blob = await res.blob();
        if (blob.size < CONFIG.minBlobBytes) {
          log.push({ source: source.name, status: `${attempt.label} too-small`, detail: `${blob.size} bytes` });
          continue;
        }
        gotBlob = blob;
        gotVia = attempt.label;
        log.push({ source: source.name, status: 'ok', detail: `${blob.size} bytes via ${attempt.label}` });
        break;
      } catch (err) {
        const detail = err.name === 'AbortError'
          ? `timeout after ${CONFIG.fetchTimeoutMs}ms`
          : err.message || 'fetch failed';
        log.push({ source: source.name, status: `${attempt.label} error`, detail });
      }
    }

    if (gotBlob) {
      const sourceLabel = gotVia === 'direct' ? source.name : `${source.name} (${gotVia})`;
      return { result: { blob: gotBlob, source: sourceLabel }, log };
    }
  }
  return { result: null, log };
}

// ─── Compositing ─────────────────────────────────────────────────────────────
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    const safety = setTimeout(() => { cleanup(); reject(new Error('image decode timeout')); }, 5000);
    img.onload = () => { clearTimeout(safety); cleanup(); resolve(img); };
    img.onerror = () => { clearTimeout(safety); cleanup(); reject(new Error('image decode failed')); };
    img.src = url;
  });
}

// Pick the most prominent saturated color from the icon. Falls back to a
// neutral dark grey if the icon is monochrome (e.g. pure black/white).
function extractDominantColor(img) {
  const size = 64;
  const cvs = document.createElement('canvas');
  cvs.width = size; cvs.height = size;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch (_) {
    // Canvas tainted by cross-origin image without CORS → can't read pixels.
    return '#1c1f26';
  }
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    if (r > 240 && g > 240 && b > 240) continue;       // skip near-white
    if (r < 25 && g < 25 && b < 25) continue;          // skip near-black
    if (Math.max(r, g, b) - Math.min(r, g, b) < 20) continue; // skip greys
    const key = `${r >> 4}|${g >> 4}|${b >> 4}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  if (buckets.size === 0) return '#1c1f26';
  let bestKey = null, bestCount = 0;
  for (const [k, v] of buckets) {
    if (v > bestCount) { bestKey = k; bestCount = v; }
  }
  const [r, g, b] = bestKey.split('|').map((n) => parseInt(n, 10) * 16 + 8);
  return `rgb(${r}, ${g}, ${b})`;
}

function renderComposite(iconImg, name, color) {
  const { W, H, iconBox, pad, maxFont, minFont, fontFamily } = CONFIG.canvas;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Icon, aspect-preserving, centred in its box
  const ratio = Math.min(iconBox / iconImg.width, iconBox / iconImg.height);
  const iw = iconImg.width * ratio;
  const ih = iconImg.height * ratio;
  const ix = pad + (iconBox - iw) / 2;
  const iy = (H - ih) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(iconImg, ix, iy, iw, ih);

  // Name beside it, sampled colour, shrink-to-fit
  const textX = pad + iconBox + pad;
  const maxTextWidth = W - textX - pad;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let fontSize = maxFont;
  while (fontSize > minFont) {
    ctx.font = `700 ${fontSize}px ${fontFamily}`;
    if (ctx.measureText(name).width <= maxTextWidth) break;
    fontSize -= 4;
  }
  ctx.fillText(name, textX, H / 2);

  return new Promise((resolve, reject) =>
    cvs.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  );
}

// ─── Card rendering ──────────────────────────────────────────────────────────
function createCard(ticker, name, domain, slug) {
  const tpl = document.getElementById('card-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.ticker').textContent = ticker;
  node.querySelector('.name').textContent = name;
  node.querySelector('.source').textContent = domain || 'no domain mapped';
  return { ticker, name, domain, slug, node, blob: null, source: null, attempts: [] };
}

function applyResult(card, blob, source) {
  card.blob = blob;
  card.source = source;
  const node = card.node;
  node.dataset.state = 'ok';

  const thumb = node.querySelector('.thumb');
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.alt = `${card.ticker} logo`;
  img.src = URL.createObjectURL(blob);
  thumb.appendChild(img);

  node.querySelector('.source').textContent = `icon via ${source}`;

  const dl = node.querySelector('.download');
  const freshDl = dl.cloneNode(true);
  freshDl.disabled = false;
  dl.replaceWith(freshDl);
  freshDl.addEventListener('click', () => triggerDownload(blob, `${card.ticker}.png`));
}

function applyError(card) {
  const node = card.node;
  node.dataset.state = 'error';
  const thumb = node.querySelector('.thumb');
  thumb.innerHTML = '<div class="error-msg">no logo</div>';

  node.querySelector('.source').textContent =
    card.domain ? `tried ${card.attempts.length} source${card.attempts.length === 1 ? '' : 's'}` : 'no domain mapped';

  const input = node.querySelector('.manual-domain');
  const retry = node.querySelector('.retry');
  input.hidden = false;
  input.value = card.domain || '';
  const freshRetry = retry.cloneNode(true);
  freshRetry.hidden = false;
  retry.replaceWith(freshRetry);
  freshRetry.addEventListener('click', async () => {
    const domain = input.value.trim().toLowerCase();
    if (!domain) return;
    card.domain = domain;
    node.dataset.state = 'loading';
    thumb.innerHTML = '<div class="spinner"></div>';
    const out = await buildLogo(card);
    card.attempts = out.log;
    if (out.blob) {
      applyResult(card, out.blob, out.source);
      document.getElementById('zip-btn').disabled = false;
    } else {
      applyError(card);
    }
  });

  const details = node.querySelector('.attempts');
  const list = node.querySelector('.attempt-log');
  list.innerHTML = '';
  for (const a of card.attempts) {
    const li = document.createElement('li');
    li.innerHTML = `<code>${a.source}</code> — ${a.status}: ${escapeHtml(a.detail)}`;
    list.appendChild(li);
  }
  details.hidden = card.attempts.length === 0;
  details.open = card.attempts.length > 0; // expand by default on failure
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ─── ZIP export ──────────────────────────────────────────────────────────────
async function onZipClicked() {
  if (typeof JSZip === 'undefined') {
    setStatus('ZIP library not loaded yet — try again in a moment.');
    return;
  }
  const zip = new JSZip();
  let added = 0;
  for (const card of cards.values()) {
    if (card.blob) { zip.file(`${card.ticker}.png`, card.blob); added++; }
  }
  if (!added) { setStatus('Nothing to bundle — no logos succeeded.'); return; }
  setStatus(`Building ZIP with ${added} logo${added === 1 ? '' : 's'}…`);
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `logos-${timestamp()}.zip`);
  setStatus(`Downloaded ${added} logo${added === 1 ? '' : 's'}.`);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
