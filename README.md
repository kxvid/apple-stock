# apple-stock

Track your exact Apple configuration, see the nearest available pickup location, and open the matching Apple purchase page as soon as stock is detected. Decisions run locally with no AI account, API key, or model fee.

It was built for the iPhone Duo on apple.com/ca and works for every iPhone, iPad, Mac, Studio Display and AirPods model in the store (Apple Watch isn't supported yet). It works in the US and Canadian Apple Stores: pick the country in the UI (ZIP codes and miles for the US). Pick a product from the menu in the UI and narrow it down by colour, storage, size, chip or connectivity. For Macs, only the standard configurations that stores keep in stock are listed. Custom build-to-order Macs always ship from Apple.

## How it works

The monitor starts a scan every 30 seconds by default. Each scan:

1. **Opens the product page** in a hidden Chrome browser, e.g. `apple.com/ca/shop/buy-iphone/iphone-duo`. The page lists every model with its part number, colour, storage and price, and the UI is built from that list.
2. **Asks Apple's stock API** (`/shop/fulfillment-messages`), the same one the Apple Store website uses, about each model near your postal code:
   - **Pickup**: is it available at an Apple Store within `MAX_DISTANCE_KM`?
   - **Courier**: can it be delivered by 2-hour courier?

   Stock requests use the same browser session as the Apple product page. If Apple rejects a request or changes its response, the UI reports the failure rather than treating an old result as current availability.
3. **Compares with last time** (saved in `.state.json`). If something went from unavailable to available, it notifies you. You get one alert per item, and you'll get another if it sells out and comes back.

```
src/index.js    starts everything: the check loop and the web UI
src/scheduler.js serializes checks and coalesces manual requests
src/checkout.js  chooses the exact variant, verified purchase link and nearest stock
src/apple.js    talks to apple.com: product menu, product pages, stock API
src/parse.js    turns Apple's pages and API replies into models and availability
src/checker.js  settings, filters, "what's new since last check", notifications
src/notify.js   email, ntfy and Discord; src/push.js is phone/browser push
src/server.js   the local web UI (src/ui.html) and its small API
```

## Adding a new device to track

**New models in a category it already covers** (a new iPhone, iPad, Mac or AirPods) need no work. On every start, the menu is rebuilt from Apple's own store pages.

**A new category** (e.g. Apple Watch or Vision Pro) is one row in `CATEGORIES` at the top of [`src/apple.js`](src/apple.js):

```js
{ id: 'buy-vision', index: 'shop/buy-vision', link: /shop\/buy-vision\/([a-z0-9-]+)/g },
```

- `id`: the part of the store URL before the model, as in `apple.com/ca/shop/buy-vision/apple-vision-pro`.
- `index`: a page that links to every model in that category.
- `link`: the pattern of those links; the bit in brackets is the model name.

Then restart and check that it shows up in the menu.

If it doesn't, Apple's product page uses a layout the app can't read yet. `parseCatalog` in [`src/parse.js`](src/parse.js) reads the two layouts Apple uses today:
- iPhone/iPad/AirPods pages: `displayValues` + `products[].partNumber`.
- Mac pages: `mainDisplayValues` + `products[].btrOrFdPartNumber`.

A new layout needs a function like `parseMacCatalog` that returns the same shape: a `title`, the option `dimensions`, and `models` with a part number, chosen options, image and price. To see what the page contains, run `productSelectionData(html)` on it. Then add a trimmed copy of the page to `test/fixtures/` with a test (`npm test`).

You can also skip the UI and set `PRODUCT=buy-vision/apple-vision-pro` in `.env`.

## Run it at home (recommended)

A computer that stays awake and connected is the best free option. The browser session stays warm between checks. Scans follow a fixed 30-second cadence measured from the previous scan’s start. If an Apple page load or network retry takes longer, the monitor skips missed slots and never overlaps scans. Computer sleep pauses monitoring; it resumes when the computer wakes. Near-instant checkout is not a guaranteed stock reservation.

```sh
git clone https://github.com/kxvid/apple-stock && cd apple-stock
npm install
npx playwright install chromium
cp .env.example .env          # fill in COUNTRY, POSTAL_CODE and MODELS
npm start                     # checks every INTERVAL_SECONDS until stopped
```

To run a single check: `npm run check`. Add `-- --dry-run` to log results without notifying or saving state.

Then open http://localhost:4321 to pick the country, model, colour, storage and postal/ZIP code. For example, `MODELS="512GB White"` watches only matching white 512GB variants; an exact part number is also supported. Settings changed in the dashboard are saved in the ignored `settings.json` and take precedence over `.env` on subsequent starts.

### Fast purchase handoff

Select one colour and storage size. The app uses Apple's own variant URL when the catalog provides one, prefers the unlocked configuration where Apple lists duplicate carrier entries, and ranks available stores by distance. Failed checks, expired results, ambiguous selections and missing exact URLs never qualify for automatic handoff.

**Open Apple when stock appears** opens a waiting tab after your click, then sends that tab to the selected model's Apple purchase page when a fresh stock result qualifies. Keep the dashboard, waiting tab, and local monitor running. A selection change or error disarms it; follow the dashboard status to re-arm. The app opens the product page, not a reserved cart: Apple still controls store choice, availability, trade-in, AppleCare, carrier options, sign-in and payment. It never places an order.

You can also use **Open your selection at Apple** at any time an exact link is available and copy the link or ZIP code. Browser and ntfy alerts remain optional; enable a channel in the UI, then use its Test action to verify delivery.

**On your phone:** browsers only allow push notifications on HTTPS pages, so the phone needs an HTTPS link to the computer. One private option is [Tailscale](https://tailscale.com): install it on both devices, run `tailscale serve --bg 4321` on the computer, and open the `https://<computer>.<tailnet>.ts.net` link it prints. Add that exact hostname to `ALLOWED_HOSTS` in `.env` and restart the monitor. The API rejects unrelated hosts and cross-origin mutations. Don't expose the UI on the public internet: anyone who can open it can change the settings.

To keep it running after reboots, see [`examples/com.apple-stock.plist`](examples/com.apple-stock.plist) (macOS launchd) or [`examples/apple-stock.service`](examples/apple-stock.service) (Linux systemd).

## Hosting

The stock worker needs an ongoing browser session and a computer that stays awake. A local process is the free, low-latency setup; hosting a static dashboard alone does not run the monitor. [Vercel Hobby cron jobs run at most once per day](https://vercel.com/docs/cron-jobs/usage-and-pricing), so Vercel's free scheduled functions do not meet a 30-second stock-check target. No Vercel deployment is required for local use.

## Run it on GitHub Actions

For when you don't have a computer that's always on.

1. Fork this repo. Scheduled workflows are free on public repos.
2. Under **Settings → Secrets and variables → Actions**:
   - Add the **variable** `POSTAL_CODE`, plus `MODELS`, `MAX_DISTANCE_KM`, `COUNTRY` or `PRODUCT` if you want something other than the defaults.
   - Add the **secrets** for your notifier: `RESEND_API_KEY` + `EMAIL_TO` (+ `EMAIL_FROM`), `NTFY_TOPIC` or `DISCORD_WEBHOOK_URL`.
3. Under **Actions**, enable workflows and run **Check stock** once by hand to confirm it works.

The workflow is scheduled every 5 minutes, but GitHub often starts scheduled runs late, and it turns off schedules after 60 days without commits. For on-time checks, have a free cron service such as [cron-job.org](https://cron-job.org) call `POST https://api.github.com/repos/<you>/apple-stock/actions/workflows/check.yml/dispatches` with body `{"ref":"main"}` and a fine-grained token that has Actions read/write on the fork.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `POSTAL_CODE` | (required) | Location used for store search and courier delivery, e.g. `M5V3L9` |
| `COUNTRY` | `ca` | Starting Apple Store country (`ca` or `us`, switchable in the UI; other paths like `uk` or `au` work from here) |
| `PRODUCT` | `iphone-duo` | Store page path, e.g. `buy-iphone/iphone-17`, `buy-ipad/ipad-air`, `buy-mac/macbook-air`, `buy-airpods/airpods-pro-3` (a bare slug means `buy-iphone/<slug>`) |
| `MODELS` | `all` | Comma-separated part numbers or words that must all appear in the model name, e.g. `256GB Night Sky, 512GB` |
| `MAX_DISTANCE_KM` | `50` | Ignore stores farther than this |
| `INTERVAL_SECONDS` | `30` | Fixed scan-start interval (minimum 30 seconds); slow scans skip missed slots |
| `STATE_FILE` | `.state.json` | Where the last seen availability is stored |
| `HEADLESS` | `true` | Set to `false` to watch the browser |
| `HOST` | `127.0.0.1` | Address the local UI listens on |
| `PORT` | `4321` | Local UI port |
| `ALLOWED_HOSTS` | (empty) | Additional comma-separated UI hostnames for a private reverse proxy; loopback names are always allowed |

### Notifiers

Configure any combination of these:

- **Phone/desktop notifications** (built in, free, no account): open the UI and tap **Turn on notifications**. On iPhone (iOS 16.4+), open the page in Safari, tap Share → **Add to Home Screen**, open it from the home screen, then turn notifications on. Alerts are sent with standard Web Push, so they arrive even when the app is closed. Keys are generated into `.vapid.json` on first run (or set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`), and devices are saved in `subscriptions.json`.
- **Email** via [Resend](https://resend.com) (free tier: 3,000 emails/month): `RESEND_API_KEY`, `EMAIL_TO` (comma-separated), and optionally `EMAIL_FROM`. Without a verified domain, Resend only delivers to the email on your Resend account, using the default `onboarding@resend.dev` sender.
- **Push** via [ntfy](https://ntfy.sh) (free app for iPhone/Android): tap **Get alerts in the ntfy app** in the UI. It picks a random topic; subscribe to that topic in the app (or tap **Subscribe**) and tap **Test**. Anyone who knows the topic can read it, so keep it random. You can also set `NTFY_TOPIC` (plus `NTFY_SERVER` if you self-host).
- **Discord**: `DISCORD_WEBHOOK_URL` from a channel's Integrations → Webhooks.

## Caveats

This uses Apple's undocumented storefront endpoints, which can change without notice. Be gentle: checking every couple of minutes is plenty. This project is not affiliated with Apple.
