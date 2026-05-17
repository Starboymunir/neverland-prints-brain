# New Render Account Migration (Zero-Guess Checklist)

Use this checklist to bring Neverland Prints live on a fresh Render account.

## 1) Create service from repo

1. Log into the new Render account.
2. Connect GitHub repo: `Starboymunir/neverland-prints-brain`.
3. Create a **Blueprint** deploy (Render will read `render.yaml`).
4. Confirm service name and branch (`main`).

## 2) Set required environment variables

In Render service settings, set these before first successful boot:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (if using local key path in container, adjust strategy)
- `GOOGLE_DRIVE_FOLDER_ID`
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ADMIN_API_TOKEN` (or client-id/client-secret pair)
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY` (if used)
- `PRODIGI_API_KEY`
- `PRODIGI_SANDBOX` (`true` for testing, `false` for live)

Optional legacy vars:

- `PRINTFUL_API_KEY`
- `PRINTFUL_AUTO_CONFIRM`

## 3) Verify service boot

Check:

- `GET /api/health` returns 200
- `GET /api/prodigi/status` returns `connected: true`

## 4) Re-register Shopify webhooks

After service URL is live, register webhooks from backend:

- `POST /api/webhooks/register`

Then verify:

- `GET /api/webhooks` includes:
  - `orders/create`
  - `orders/paid`

## 5) Fulfillment smoke test

1. Place a test order from storefront.
2. Confirm webhook receives order.
3. Confirm DB row in `fulfillment_orders` updates to `sent_to_prodigi`.
4. Confirm `prodigi_order_id` exists.

## 6) Go live safely

1. Keep `PRODIGI_SANDBOX=true` for first test cycle.
2. Switch to `PRODIGI_SANDBOX=false` only after successful end-to-end test.
3. Run one low-value live order and verify tracking/status updates.

## Common failure points

- Missing Shopify secret/token
- Wrong Prodigi key/environment mismatch (live key used against sandbox API or vice versa)
- Missing webhook registration after URL change
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` not available inside Render runtime
