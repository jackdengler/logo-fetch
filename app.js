// ─── Config ──────────────────────────────────────────────────────────────────
// Both tokens are *publishable* and safe to ship to the browser. If you fork
// this and want better wordmark coverage, drop in your own:
//   • Brandfetch clientId: https://developers.brandfetch.com/
//   • logo.dev token:      https://www.logo.dev/
const CONFIG = {
  brandfetchClientId: '',
  logoDevToken: '',
  concurrency: 6,
  minBlobBytes: 500, // weed out 1x1 / empty placeholders
};

// ─── Source chain ────────────────────────────────────────────────────────────
// Tried in order; first hit wins.
const SOURCES = [
  {
    name: 'Brandfetch',
    enabled: () => !!CONFIG.brandfetchClientId,
    url: (_, domain) =>
      domain
        ? `https://cdn.brandfetch.io/${domain}/w/512/h/512/theme/light/logo?c=${CONFIG.brandfetchClientId}`
        : null,
  },
  {
    name: 'logo.dev',
    enabled: () => !!CONFIG.logoDevToken,
    url: (ticker) =>
      `https://img.logo.dev/ticker/${ticker}?token=${CONFIG.logoDevToken}&format=png&retina=true`,
  },
  {
    name: 'Clearbit',
    enabled: () => true,
    url: (_, domain) => (domain ? `https://logo.clearbit.com/${domain}` : null),
  },
];

// ─── State ───────────────────────────────────────────────────────────────────
let TICKER_MAP = {}; // { AAPL: { name, domain } }
const cards = new Map(); // ticker -> { ticker, name, domain, blob, source, ext, node }

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
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onFetchClicked();
  });
}

// ─── Input handling ──────────────────────────────────────────────────────────
function parseTickers(raw) {
  return [...new Set(
    raw
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  )];
}

function onFetchClicked() {
  const raw = document.getElementById('tickers').value;
  const tickers = parseTickers(raw);
  if (!tickers.length) {
    setStatus('Enter at least one ticker.');
    return;
  }
  runFetch(tickers);
}

async function runFetch(tickers) {
  document.getElementById('fetch-btn').disabled = true;
  document.getElementById('zip-btn').disabled = true;
  setStatus(`Fetching ${tickers.length} logo${tickers.length === 1 ? '' : 's'}…`);

  // Reset prior results
  const grid = document.getElementById('results');
  grid.innerHTML = '';
  cards.clear();

  // Spawn cards immediately so user sees progress
  for (const ticker of tickers) {
    const entry = TICKER_MAP[ticker] || {};
    const card = createCard(ticker, entry.name || '', entry.domain || '');
    cards.set(ticker, card);
    grid.appendChild(card.node);
  }

  let okCount = 0;
  await processWithConcurrency(tickers, async (ticker) => {
    const card = cards.get(ticker);
    const result = await fetchLogo(ticker, card.domain);
    if (result) {
      okCount++;
      applyResult(card, result);
    } else {
      applyError(card, 'No source returned a logo.');
    }
  }, CONFIG.concurrency);

  setStatus(`Done. ${okCount}/${tickers.length} succeeded.`);
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

// ─── Fetching ────────────────────────────────────────────────────────────────
async function fetchLogo(ticker, domain) {
  for (const source of SOURCES) {
    if (!source.enabled()) continue;
    const url = source.url(ticker, domain);
    if (!url) continue;
    try {
      const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) continue;
      const blob = await res.blob();
      if (blob.size < CONFIG.minBlobBytes) continue;
      return { blob, source: source.name, ext: extFromContentType(ct) };
    } catch (_) {
      // CORS / network failure → try next
    }
  }
  return null;
}

function extFromContentType(ct) {
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'png';
}

// ─── Card rendering ──────────────────────────────────────────────────────────
function createCard(ticker, name, domain) {
  const tpl = document.getElementById('card-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.ticker').textContent = ticker;
  node.querySelector('.name').textContent = name || '—';
  node.querySelector('.source').textContent = domain ? domain : 'no domain mapped';
  return { ticker, name, domain, node, blob: null, source: null, ext: 'png' };
}

function applyResult(card, { blob, source, ext }) {
  card.blob = blob;
  card.source = source;
  card.ext = ext;
  const node = card.node;
  node.dataset.state = 'ok';

  const thumb = node.querySelector('.thumb');
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.alt = `${card.ticker} logo`;
  img.src = URL.createObjectURL(blob);
  thumb.appendChild(img);

  node.querySelector('.source').textContent = `via ${source}`;

  const dl = node.querySelector('.download');
  dl.disabled = false;
  dl.addEventListener('click', () => triggerDownload(blob, `${card.ticker}.${ext}`));
}

function applyError(card, msg) {
  const node = card.node;
  node.dataset.state = 'error';
  const thumb = node.querySelector('.thumb');
  thumb.innerHTML = '<div class="error-msg">no logo</div>';

  const input = node.querySelector('.manual-domain');
  const retry = node.querySelector('.retry');
  input.hidden = false;
  input.value = card.domain || '';
  retry.hidden = false;
  retry.addEventListener('click', async () => {
    const domain = input.value.trim().toLowerCase();
    if (!domain) return;
    card.domain = domain;
    node.dataset.state = 'loading';
    thumb.innerHTML = '<div class="spinner"></div>';
    const result = await fetchLogo(card.ticker, domain);
    if (result) {
      applyResult(card, result);
      document.getElementById('zip-btn').disabled = false;
    } else {
      applyError(card, msg);
    }
  });

  const sourceLine = node.querySelector('.source');
  sourceLine.textContent = msg;
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
    if (card.blob) {
      zip.file(`${card.ticker}.${card.ext}`, card.blob);
      added++;
    }
  }
  if (!added) {
    setStatus('Nothing to bundle — no logos succeeded.');
    return;
  }
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
