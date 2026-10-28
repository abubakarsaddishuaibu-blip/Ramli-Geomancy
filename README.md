# Ramli-Geomancy
Ramli Hausa Android app with AI interpretation and Supabase integration.

---

## Registration, one-time ₦15,000 fee (Paystack) & private history

The app is no longer an open static page. A Node backend (`server.js`) now sits in
front of the original Ramli UI and enforces access:

1. **Registration required** – every new user registers with full name, email and
   password (`/api/auth/register`). Passwords live in Supabase Auth only.
2. **One-time fee ₦15,000** – a new user is `unpaid` and cannot use any Ramli
   feature. They pay via Paystack (`/api/payments/initialize`). The **server**
   verifies the transaction with the Paystack **secret key**
   (`/api/payments/verify`, plus an HMAC-signed webhook endpoint). Only after the
   backend confirms `status === 'success'` and the exact amount/currency is the
   account marked `paid` and the UI unlocks.
3. **Unlimited afterwards** – no credits, no per-question charge, no usage fees.
   A paid account can re-initialise a payment only through the server, which
   refuses (`already_paid`) instead of creating a second charge.
4. **Private history** – questions, figures, interpretations and timestamps are
   written to `ramli_history` (Supabase) with Row Level Security so each user
   only ever sees their own rows.

### Files

| Path | Purpose |
| --- | --- |
| `server.js` | Zero-dependency HTTP server: auth, payment init/verify/webhook, history API, static hosting |
| `lib/config.js` | Environment-only configuration (secrets never leave the server) |
| `lib/supabase.js` | Supabase Auth + PostgREST helpers (service key used server-side only) |
| `lib/paystack.js` | Paystack initialise / verify / webhook signature helpers |
| `lib/session.js` | Signed session tokens |
| `geomancy_auth.js` | Frontend auth gate, payment gate and private-history UI |
| `geomancy_dream_app_gwaji.html` | Original Ramli UI – symbols, rules and interpretation logic untouched |
| `db/schema.sql` | Tables, indexes and RLS policies – run once in the Supabase SQL editor |
| `tests/api.test.mjs` | End-to-end API tests against mock Supabase + mock Paystack |

### Setup

1. Create/connect a Supabase project, then run `db/schema.sql` in the SQL editor.
2. Copy `.env.example` to `.env` (or add the variables as repository environment
   variables) and fill in the Supabase keys, the Paystack secret key,
   `SESSION_SECRET` and `APP_BASE_URL`.
3. Set the Paystack webhook to `https://<your-domain>/api/payments/webhook`
   (optional but recommended; it enables automatic unlocking after payment).
4. `npm start` (local) or deploy the included `Dockerfile`.

### Environment variables (never paste keys into chat or commit them)

| Variable | Required | Where to get it | Where to enter it |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase → Project Settings → API → Project URL | AppJet **Settings → Environment Variables** (or local `.env`) |
| `SUPABASE_ANON_KEY` | yes | Supabase → Project Settings → API → *anon / public* key | same |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase → Project Settings → API → *service_role* key | same — **server only, never in the browser** |
| `PAYSTACK_SECRET_KEY` | yes | Paystack dashboard → Settings → API Keys → Secret Key | same — **server only** |
| `SESSION_SECRET` | yes | any long random string you invent (e.g. 40+ chars) | same |
| `APP_BASE_URL` | yes | the public URL of this deployed app | same |
| `PORT` | no | defaults to `3000` | same |
| `REGISTRATION_FEE_KOBO` | no | defaults to `1500000` (₦15,000) | same |
| `PAYSTACK_BASE_URL` | no | defaults to `https://api.paystack.co` | same |

Rules that are enforced by the code and by the tests:

* Secrets live **only** in the server environment. The frontend bundle never
  contains a secret key (asserted by `tests/api.test.mjs`).
* Local development: `cp .env.example .env`, fill it in, and keep `.env` out of
  git (it is already git-ignored). Never commit `.env`.
* In the hosted app: open the project **Settings → Environment Variables**,
  add each key/value there, and redeploy. Do not post the values in chat and do
  not create a `.env` file inside the repository.

### Tests: mock vs. real

```bash
npm test              # 26 checks, 100% mock (mock Supabase + mock Paystack)
npm run test:integration   # REAL test – needs live Supabase + Paystack keys
```

* `npm test` = `tests/api.test.mjs` (15 API checks against in-process mock
  Supabase/Paystack) + `tests/schema.test.mjs` (11 static checks that
  `db/schema.sql` matches the backend and that RLS protects every user's
  history). These prove the logic, **not** a real payment.
* `npm run test:integration` (`tests/integration.test.mjs`) talks to the real
  Supabase project and the real Paystack API. It never completes a charge: it
  creates a real transaction and asserts that an **unpaid** transaction does
  **not** unlock the account. Without credentials it prints `SKIPPED` and exits
  0.

### Setting up Supabase from an Android phone

1. Open Chrome and go to **https://supabase.com/dashboard** → sign in (or
   create an account).
2. Tap **New project** → organisation → name it (e.g. `ramli`) → generate a
   strong database password and **store it in the phone's password manager**
   (the app never needs this password) → pick the region closest to Nigeria
   (e.g. Frankfurt / South Africa) → **Create new project**. Wait ~1 minute.
3. In the AppJet dashboard tap the **Connect to Supabase** button that was
   shown above. Once connected, the platform stores the URL and keys for you —
   you do not have to copy any key by hand.
4. Apply the schema: in the Supabase dashboard tap **SQL Editor** → **New
   query** → open `db/schema.sql` from this repository (the file is in the
   repository root under `db/`), copy its whole content into the editor and tap
   **Run**. It must report success and creates the three tables
   (`profiles`, `payments`, `ramli_history`) with Row Level Security enabled.
5. In Supabase → **Authentication → Providers → Email**, make sure the Email
   provider is enabled. Turn **"Confirm email" OFF** so users can sign in
   immediately after registering (the backend creates the account with
   `email_confirm: true`).
6. Supabase → **Settings → API**: copy the Project URL, the *anon* key and the
   *service_role* key. Paste them into the AppJet **Settings → Environment
   Variables** page (never into chat, never into a committed file).
7. Paystack: on the phone open **https://dashboard.paystack.com** → sign in
   → **Settings → API Keys** → copy the **Secret Key** (start with `sk_test_…`
   while testing) → add it to the same Environment Variables page as
   `PAYSTACK_SECRET_KEY`.
8. Paystack → **Settings → API Keys & Webhooks → Webhooks / Webhook URLs** →
   add `https://<your-app-domain>/api/payments/webhook` (the webhook is
   optional, but it makes unlocking automatic; the app can also unlock by
   re-checking the payment status itself).
9. Set `SESSION_SECRET` to a long random string and `APP_BASE_URL` to the
   public URL of the deployed app, then redeploy.
10. Check `https://<your-app-domain>/api/config` — it must show
    `"supabase_configured": true`, `"paystack_configured": true`,
    `"registration_fee_display": "₦15,000"` and an empty `"missing": []`.

### Notes

* There is **no credit system** in this project – it was never present and none
  was introduced.
* No secret key is ever embedded in the frontend; the browser only talks to this
  backend with a bearer session token.
