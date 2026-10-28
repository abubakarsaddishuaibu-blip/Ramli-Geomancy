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

```bash
npm test   # runs the API test-suite against mock services
```

### Notes

* There is **no credit system** in this project – it was never present and none
  was introduced.
* No secret key is ever embedded in the frontend; the browser only talks to this
  backend with a bearer session token.
