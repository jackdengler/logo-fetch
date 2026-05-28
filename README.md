# Ticker → Logo Fetch

Paste a list of stock tickers, get transparent-PNG logos back. Pure static
site — runs entirely in the browser, deployable to GitHub Pages with no
backend.

## Usage

1. Open the deployed page (or `python3 -m http.server 8000` locally and visit
   `http://localhost:8000`).
2. Paste tickers into the textarea, separated by commas, spaces, or newlines.
3. Click **Fetch logos**. Each card shows the logo, the source it came from,
   and a per-logo **Download** button.
4. Click **Download all as ZIP** to bundle every successful logo into one zip.
5. For any ticker that fails, type the company's primary domain into the
   inline input on its card and click **Retry**.

## How the source chain works

Each ticker is tried against these sources in order; the first one that
returns a real image wins:

| # | Source        | Needs                         | Notes                                    |
|---|---------------|-------------------------------|------------------------------------------|
| 1 | Brandfetch    | `brandfetchClientId` (free)   | Best for wordmarks (logo + company name) |
| 2 | logo.dev      | `logoDevToken` (free, public) | Native ticker→domain; high coverage      |
| 3 | Clearbit      | — none —                      | Always-on fallback; mostly icon-style    |

Out of the box only **Clearbit** is enabled, so the app works with zero
configuration. For better wordmark coverage, drop your own tokens into
`CONFIG` at the top of `app.js`:

```js
const CONFIG = {
  brandfetchClientId: 'YOUR_CLIENT_ID', // brandfetch.com/developers
  logoDevToken:       'pk_XXXXXXXX',    // logo.dev
  ...
};
```

Both providers issue *publishable* tokens that are designed to ship in
client-side code.

## Ticker → domain map

`data/tickers.json` is the lookup table the app uses when a source requires
a domain. The seed list covers ~160 well-known US large-caps. To add more,
just edit the file:

```json
{
  "AAPL": { "name": "Apple", "domain": "apple.com" },
  ...
}
```

Tickers that aren't in the map can still resolve via logo.dev (which has its
own ticker resolution), or via the per-card manual-domain retry input.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. Repo **Settings** → **Pages** → **Source: Deploy from a branch** →
   branch `main`, folder `/ (root)`.
3. Wait ~30 seconds; visit `https://<your-user>.github.io/logo-fetch/`.

The included `.nojekyll` file prevents GitHub's Jekyll pipeline from
touching the assets.
