// ─── Config ──────────────────────────────────────────────────────────────────
// Tokens are persisted in localStorage from the in-page Settings panel.
// fontSize is in *points* (like PowerPoint / Excel / Word), not CSS pixels.
// Converted to canvas pixels via PT_TO_PX = 4/3 at draw time.
const PT_TO_PX = 4 / 3;
const OUTPUT_DEFAULTS = {
  font: 'Segoe UI',
  fontSize: 12,        // points
  showName: true,
  cellW: 1024,
  cellH: 256,
  gridCols: 4,
  gridPad: 16,
};
const OUTPUT = loadOutputSettings();

function loadOutputSettings() {
  // Bumped key when fontSize semantics changed from px to pt so old saved
  // values (e.g. 110 = 110px) don't render as huge 110pt fonts.
  try {
    const raw = localStorage.getItem('output_v2');
    if (raw) return { ...OUTPUT_DEFAULTS, ...JSON.parse(raw) };
  } catch (_) { /* ignore */ }
  return { ...OUTPUT_DEFAULTS };
}

function fontStack(name) {
  // Always end with a system fallback so the canvas renders something even if
  // the webfont didn't load or isn't installed locally.
  return `"${name}", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
}

const CONFIG = {
  brandfetchClientId: localStorage.getItem('brandfetchClientId') || '',
  logoDevToken: localStorage.getItem('logoDevToken') || '',
  concurrency: 3,
  minBlobBytes: 200,
  retryDelayMs: 400,
  // Repo metadata for the "last updated" indicator
  repo: { owner: 'jackdengler', name: 'logo-fetch' },
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
    url: ({ domain }) => {
      if (!domain) return null;
      // Chrome's internal favicon endpoint, served from Google's CDN (gstatic).
      // Generally has more permissive CORS than the legacy s2/favicons URL.
      return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=256`;
    },
  },
];

// ─── State ───────────────────────────────────────────────────────────────────
let TICKER_MAP = {};
const cards = new Map();
// Monotonic id of the current fetch run. Any in-flight fetches from a prior
// run check this before mutating state — if the user kicked off a new run,
// the old promise's result is discarded so it can't clobber fresh cards.
let currentRunId = 0;

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
  document.getElementById('grid-btn').addEventListener('click', onGridClicked);
  document.getElementById('copy-grid-btn').addEventListener('click', onCopyGridClicked);
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

  // Populate every settings input from the saved/default values.
  document.getElementById('opt-font').value = OUTPUT.font;
  document.getElementById('opt-font-size').value = OUTPUT.fontSize;
  document.getElementById('opt-show-name').checked = OUTPUT.showName;
  document.getElementById('opt-grid-cols').value = OUTPUT.gridCols;
  document.getElementById('opt-grid-pad').value = OUTPUT.gridPad;
  document.getElementById('brandfetch-id').value = CONFIG.brandfetchClientId;
  document.getElementById('logodev-token').value = CONFIG.logoDevToken;

  document.getElementById('save-settings').addEventListener('click', async () => {
    OUTPUT.font = document.getElementById('opt-font').value;
    OUTPUT.fontSize = Math.max(6, parseInt(document.getElementById('opt-font-size').value, 10) || OUTPUT_DEFAULTS.fontSize);
    const wasShowName = OUTPUT.showName;
    OUTPUT.showName = document.getElementById('opt-show-name').checked;
    OUTPUT.gridCols = Math.max(1, parseInt(document.getElementById('opt-grid-cols').value, 10) || OUTPUT_DEFAULTS.gridCols);
    OUTPUT.gridPad = Math.max(0, parseInt(document.getElementById('opt-grid-pad').value, 10) || 0);
    localStorage.setItem('output_v2', JSON.stringify(OUTPUT));

    // If the global Show-name toggle flipped, apply it to every card. This
    // gives users a one-click "name everywhere / no name anywhere" switch
    // while still preserving the per-card overrides made afterwards.
    if (OUTPUT.showName !== wasShowName) {
      for (const card of cards.values()) card.showName = OUTPUT.showName;
    }

    // API tokens
    const bf = document.getElementById('brandfetch-id').value.trim();
    const ld = document.getElementById('logodev-token').value.trim();
    CONFIG.brandfetchClientId = bf;
    CONFIG.logoDevToken = ld;
    if (bf) localStorage.setItem('brandfetchClientId', bf);
    else localStorage.removeItem('brandfetchClientId');
    if (ld) localStorage.setItem('logoDevToken', ld);
    else localStorage.removeItem('logoDevToken');

    const status = document.getElementById('settings-status');
    status.textContent = 'Saved. Re-rendering…';
    await reRenderAll();
    status.textContent = 'Saved.';
    setTimeout(() => (status.textContent = ''), 1500);
  });

  showLastCommit();
}

// Fetches the latest commit on `main` from the GitHub REST API and renders
// a small "Last code update: …" line in the header. Lets the user know
// they're on the version they think they are.
async function showLastCommit() {
  const el = document.getElementById('version');
  if (!el) return;
  const { owner, name } = CONFIG.repo;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/commits/main`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const date = new Date(data.commit.author.date);
    const sha = (data.sha || '').slice(0, 7);
    const url = `https://github.com/${owner}/${name}/commit/${data.sha}`;
    el.innerHTML = `Last code update: ${relativeTime(date)} &middot; <a href="${url}" target="_blank" rel="noopener">${sha}</a>`;
  } catch (err) {
    el.textContent = `Last code update: unknown (${err.message})`;
  }
}

function relativeTime(d) {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  return d.toISOString().slice(0, 10);
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
  const runId = ++currentRunId;
  setControlsBusy(true);
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
    // Stale result from a superseded run — discard.
    if (runId !== currentRunId) return;
    card.attempts = out.log;
    if (out.blob) {
      okCount++;
      card.triedSourceIdxs.add(out.sourceIdx);
      card.sourceIdx = out.sourceIdx;
      applyResult(card, out.blob, out.source);
    } else {
      applyError(card);
    }
  }, CONFIG.concurrency);

  if (runId !== currentRunId) return;

  let statusMsg = `Done. ${okCount}/${tickers.length} succeeded.`;
  if (okCount === 0) {
    const firstCard = [...cards.values()].find((c) => c.attempts.length > 0);
    if (firstCard) {
      const lastErr = firstCard.attempts[firstCard.attempts.length - 1];
      statusMsg += ` Last error: ${lastErr.source} ${lastErr.status} — ${lastErr.detail}`;
    }
  }
  setStatus(statusMsg);
  document.getElementById('fetch-btn').disabled = false;
  if (okCount > 0) {
    document.getElementById('zip-btn').disabled = false;
    document.getElementById('grid-btn').disabled = false;
    document.getElementById('copy-grid-btn').disabled = false;
  }
}

function setControlsBusy(busy) {
  for (const id of ['fetch-btn', 'zip-btn', 'grid-btn', 'copy-grid-btn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
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
async function buildLogo(card, skipIdxs = new Set()) {
  const ctx = {
    ticker: card.ticker,
    domain: card.domain,
    name: card.name,
    slug: card.slug || deriveSlug(card.name || card.ticker),
  };
  const { result, log } = await fetchIcon(ctx, skipIdxs);
  if (!result) return { blob: null, source: null, sourceIdx: -1, log };
  try {
    const iconImg = await blobToImage(result.blob);
    const color = extractDominantColor(iconImg);
    // Cache on the card so a settings change can re-composite without re-fetch.
    card.iconImg = iconImg;
    card.color = color;
    const composedBlob = await renderComposite(iconImg, card.name || card.ticker, color);
    return { blob: composedBlob, source: result.source, sourceIdx: result.sourceIdx, log };
  } catch (err) {
    log.push({ source: 'composite', status: 'error', detail: err.message || 'compose failed' });
    return { blob: null, source: null, sourceIdx: -1, log };
  }
}

// Re-composite every card that already has a decoded icon, using current
// OUTPUT settings. Honors each card's per-card name visibility.
async function reRenderAll() {
  setStatus('Re-rendering with new settings…');
  await ensureFontLoaded();
  let n = 0;
  for (const card of cards.values()) {
    if (!card.iconImg) continue;
    try {
      const blob = await renderCardComposite(card);
      if (blob) {
        applyResult(card, blob, card.source || 'cached');
        n++;
      }
    } catch (err) {
      console.error('re-render', card.ticker, err);
    }
  }
  setStatus(`Re-rendered ${n} card(s).`);
}

async function fetchIcon(ctx, skipIdxs = new Set()) {
  const log = [];
  for (let sourceIdx = 0; sourceIdx < SOURCES.length; sourceIdx++) {
    const source = SOURCES[sourceIdx];
    if (skipIdxs.has(sourceIdx)) {
      log.push({ source: source.name, status: 'skipped', detail: 'already tried' });
      continue;
    }
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
      // One immediate try plus one retry after a brief backoff — covers
      // transient network blips and CDN rate-limit hiccups.
      for (let tryIdx = 0; tryIdx < 2 && !gotBlob; tryIdx++) {
        if (tryIdx > 0) await new Promise((r) => setTimeout(r, CONFIG.retryDelayMs));
        const tag = tryIdx === 0 ? attempt.label : `${attempt.label} retry`;
        try {
          const res = await fetchWithTimeout(attempt.url, { mode: 'cors', redirect: 'follow' });
          if (!res.ok) {
            log.push({ source: source.name, status: `${tag} http`, detail: `HTTP ${res.status}` });
            continue;
          }
          const ct = res.headers.get('content-type') || '';
          if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
            log.push({ source: source.name, status: `${tag} bad-type`, detail: ct });
            continue;
          }
          const blob = await res.blob();
          if (blob.size < CONFIG.minBlobBytes) {
            log.push({ source: source.name, status: `${tag} too-small`, detail: `${blob.size} bytes` });
            continue;
          }
          gotBlob = blob;
          gotVia = tag;
          log.push({ source: source.name, status: 'ok', detail: `${blob.size} bytes via ${tag}` });
          break;
        } catch (err) {
          const detail = err.name === 'AbortError'
            ? `timeout after ${CONFIG.fetchTimeoutMs}ms`
            : err.message || 'fetch failed';
          log.push({ source: source.name, status: `${tag} error`, detail });
        }
      }
      if (gotBlob) break;
    }

    if (gotBlob) {
      const sourceLabel = gotVia === 'direct' ? source.name : `${source.name} (${gotVia})`;
      return { result: { blob: gotBlob, source: sourceLabel, sourceIdx }, log };
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

// Oversampling factor — render the canvas this many times larger than the
// nominal point size so the PNG stays crisp when scaled in PowerPoint.
const SCALE = 3;

// Compute the canvas geometry for a single composite. When `name` is null,
// the cell is icon-only. The icon is sized to match the font cap-height so
// they read at the same visual weight.
function getMetrics(name) {
  const fontPx = Math.round(OUTPUT.fontSize * PT_TO_PX * SCALE);
  const iconSize = fontPx; // 1:1 with font — visually balanced
  const pad = Math.round(fontPx * 0.5);

  if (!name) {
    return { fontPx, iconSize, pad, cellW: iconSize + pad * 2, cellH: iconSize + pad * 2 };
  }

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `700 ${fontPx}px ${fontStack(OUTPUT.font)}`;
  const textW = measure.measureText(name).width;
  return {
    fontPx,
    iconSize,
    pad,
    cellW: Math.round(pad + iconSize + pad + textW + pad),
    cellH: Math.round(pad + Math.max(iconSize, fontPx) + pad),
  };
}

// Like getMetrics but uses the widest text in the array — so all grid cells
// share a uniform width.
function getMetricsForGroup(names) {
  const fontPx = Math.round(OUTPUT.fontSize * PT_TO_PX * SCALE);
  const iconSize = fontPx;
  const pad = Math.round(fontPx * 0.5);
  const hasNames = names && names.some((n) => !!n);
  if (!hasNames) {
    return { fontPx, iconSize, pad, cellW: iconSize + pad * 2, cellH: iconSize + pad * 2 };
  }
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `700 ${fontPx}px ${fontStack(OUTPUT.font)}`;
  let maxW = 0;
  for (const n of names) {
    if (!n) continue;
    const w = measure.measureText(n).width;
    if (w > maxW) maxW = w;
  }
  return {
    fontPx,
    iconSize,
    pad,
    cellW: Math.round(pad + iconSize + pad + maxW + pad),
    cellH: Math.round(pad + Math.max(iconSize, fontPx) + pad),
  };
}

function paintComposite(ctx, iconImg, name, color, x, y, m) {
  // Icon — aspect-preserving fit into a `iconSize × iconSize` box,
  // vertically centered in the cell.
  const ratio = Math.min(m.iconSize / iconImg.width, m.iconSize / iconImg.height);
  const iw = iconImg.width * ratio;
  const ih = iconImg.height * ratio;
  const iconBoxX = name ? x + m.pad : x + (m.cellW - m.iconSize) / 2;
  const iconBoxY = y + (m.cellH - m.iconSize) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(iconImg, iconBoxX + (m.iconSize - iw) / 2, iconBoxY + (m.iconSize - ih) / 2, iw, ih);

  if (!name) return;

  const textX = iconBoxX + m.iconSize + m.pad;
  const maxTextWidth = x + m.cellW - textX - m.pad;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let px = m.fontPx;
  while (px > 8) {
    ctx.font = `700 ${px}px ${fontStack(OUTPUT.font)}`;
    if (ctx.measureText(name).width <= maxTextWidth) break;
    px -= 2;
  }
  ctx.fillText(name, textX, y + m.cellH / 2);
}

// Render a single card to a transparent PNG. `nameOverride` lets the per-card
// name toggle hide the name on just one card; pass null/empty for icon-only.
async function renderComposite(iconImg, displayName, color) {
  await ensureFontLoaded();
  const m = getMetrics(displayName);
  const cvs = document.createElement('canvas');
  cvs.width = m.cellW; cvs.height = m.cellH;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, m.cellW, m.cellH);
  paintComposite(ctx, iconImg, displayName, color, 0, 0, m);
  return new Promise((resolve, reject) =>
    cvs.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  );
}

// Ensure the current OUTPUT.font is loaded before drawing. Canvas silently
// falls back to a default font if you try to draw with an unloaded face.
// Capped at 1.2s so a hung/slow webfont CDN can't stall the entire fetch
// pipeline — we'd rather render in a system fallback than not at all.
async function ensureFontLoaded() {
  if (!('fonts' in document)) return;
  try {
    await Promise.race([
      document.fonts.load(`700 ${OUTPUT.fontSize}px "${OUTPUT.font}"`),
      new Promise((r) => setTimeout(r, 1200)),
    ]);
  } catch (_) { /* fallback handled by font stack */ }
}

// ─── Card rendering ──────────────────────────────────────────────────────────
function createCard(ticker, name, domain, slug) {
  const tpl = document.getElementById('card-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.ticker').textContent = ticker;
  node.querySelector('.name').textContent = name;
  node.querySelector('.source').textContent = domain || 'no domain mapped';
  return {
    ticker, name, domain, slug, node,
    blob: null, source: null, sourceIdx: -1,
    triedSourceIdxs: new Set(),
    showName: OUTPUT.showName,   // per-card override of global default
    iconImg: null, color: null,
    attempts: [],
  };
}

// Re-render this card's composite from the cached iconImg/color using its
// current per-card name visibility. Used after the user toggles "Hide name".
async function renderCardComposite(card) {
  if (!card.iconImg) return null;
  const displayName = card.showName ? (card.name || card.ticker) : null;
  const blob = await renderComposite(card.iconImg, displayName, card.color || '#1c1f26');
  return blob;
}

function applyResult(card, blob, source) {
  card.blob = blob;
  card.source = source;
  const node = card.node;
  node.dataset.state = 'ok';

  // Swap thumbnail
  const thumb = node.querySelector('.thumb');
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.alt = `${card.ticker} logo`;
  img.src = URL.createObjectURL(blob);
  thumb.appendChild(img);

  node.querySelector('.source').textContent = `via ${source}`;

  // Copy
  const copyBtn = node.querySelector('.copy');
  const freshCopy = copyBtn.cloneNode(true);
  freshCopy.disabled = false;
  copyBtn.replaceWith(freshCopy);
  freshCopy.addEventListener('click', async () => {
    const ok = await copyBlobToClipboard(card.blob);
    if (ok) flashButton(freshCopy, 'Copied');
  });

  // Download
  const dl = node.querySelector('.download');
  const freshDl = dl.cloneNode(true);
  freshDl.disabled = false;
  dl.replaceWith(freshDl);
  freshDl.addEventListener('click', () => triggerDownload(card.blob, `${card.ticker}.png`));

  // Per-card name toggle
  const toggle = node.querySelector('.toggle-name');
  const freshToggle = toggle.cloneNode(true);
  freshToggle.disabled = false;
  freshToggle.textContent = card.showName ? 'Hide name' : 'Show name';
  toggle.replaceWith(freshToggle);
  freshToggle.addEventListener('click', async () => {
    card.showName = !card.showName;
    freshToggle.textContent = card.showName ? 'Hide name' : 'Show name';
    freshToggle.disabled = true;
    const newBlob = await renderCardComposite(card);
    if (newBlob) {
      card.blob = newBlob;
      img.src = URL.createObjectURL(newBlob);
    }
    freshToggle.disabled = false;
  });

  // Try next source
  const next = node.querySelector('.next-source');
  const freshNext = next.cloneNode(true);
  freshNext.disabled = false;
  next.replaceWith(freshNext);
  freshNext.addEventListener('click', async () => {
    freshNext.disabled = true;
    node.dataset.state = 'loading';
    thumb.innerHTML = '<div class="spinner"></div>';
    const out = await buildLogo(card, card.triedSourceIdxs);
    if (out.blob) {
      card.triedSourceIdxs.add(out.sourceIdx);
      card.sourceIdx = out.sourceIdx;
      applyResult(card, out.blob, out.source);
    } else {
      // No more sources — restore the current good logo and let the user know.
      node.dataset.state = 'ok';
      thumb.innerHTML = '';
      const restoreImg = document.createElement('img');
      restoreImg.alt = `${card.ticker} logo`;
      restoreImg.src = URL.createObjectURL(card.blob);
      thumb.appendChild(restoreImg);
      flashButton(freshNext, 'No more sources');
    }
    freshNext.disabled = false;
  });
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
    card.triedSourceIdxs = new Set();
    node.dataset.state = 'loading';
    thumb.innerHTML = '<div class="spinner"></div>';
    const out = await buildLogo(card);
    card.attempts = out.log;
    if (out.blob) {
      card.triedSourceIdxs.add(out.sourceIdx);
      card.sourceIdx = out.sourceIdx;
      applyResult(card, out.blob, out.source);
      document.getElementById('zip-btn').disabled = false;
      document.getElementById('grid-btn').disabled = false;
      document.getElementById('copy-grid-btn').disabled = false;
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
  details.open = false; // expanded only when the user clicks the summary
}

// Briefly swap a button's label to give feedback, then restore.
function flashButton(btn, msg, ms = 1400) {
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, ms);
}

// Copy a Blob (PNG) to the system clipboard via the async Clipboard API.
async function copyBlobToClipboard(blob) {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('Clipboard API unavailable in this browser');
    }
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    return true;
  } catch (err) {
    setStatus(`Copy failed: ${err.message}`);
    return false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Build a single PNG that tiles every successful logo in a grid. Uses a
// uniform cell size based on the widest name so columns align cleanly.
// Each cell still respects its card's per-card `showName` toggle.
async function buildGridBlob() {
  const ready = [...cards.values()].filter((c) => c.iconImg);
  if (!ready.length) return null;
  await ensureFontLoaded();

  // Cell size — derive uniform cellW from the widest visible name. Cards
  // hiding their name still slot into the same cell width for alignment.
  const visibleNames = ready.map((c) => (c.showName ? (c.name || c.ticker) : ''));
  const m = getMetricsForGroup(visibleNames);

  const cols = Math.min(OUTPUT.gridCols, ready.length);
  const rows = Math.ceil(ready.length / cols);
  const pad = OUTPUT.gridPad * SCALE;
  const W = cols * m.cellW + (cols + 1) * pad;
  const H = rows * m.cellH + (rows + 1) * pad;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  ready.forEach((card, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (m.cellW + pad);
    const y = pad + row * (m.cellH + pad);
    const displayName = card.showName ? (card.name || card.ticker) : null;
    paintComposite(ctx, card.iconImg, displayName, card.color || '#1c1f26', x, y, m);
  });

  return new Promise((resolve, reject) =>
    cvs.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  );
}

async function onGridClicked() {
  setStatus('Building grid PNG…');
  const blob = await buildGridBlob();
  if (!blob) { setStatus('Nothing to grid — no logos succeeded.'); return; }
  triggerDownload(blob, `logo-grid-${timestamp()}.png`);
  setStatus(`Downloaded grid PNG (${blob.size.toLocaleString()} bytes).`);
}

async function onCopyGridClicked() {
  setStatus('Building grid PNG…');
  const blob = await buildGridBlob();
  if (!blob) { setStatus('Nothing to grid — no logos succeeded.'); return; }
  const ok = await copyBlobToClipboard(blob);
  if (ok) setStatus('Grid PNG copied to clipboard.');
}

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
