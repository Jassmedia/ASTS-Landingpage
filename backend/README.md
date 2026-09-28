# ASTS Backend

Node.js + Express API for the ASTS Training landing page:

- **Book Free Demo registrations**, stored in Supabase (PostgreSQL)
- **Anonymous visitor and click tracking** (page views, demo-button clicks, form starts)
- **Leads dashboard** at `/dashboard/` with stats, funnel, daily trend and lead tables
- **Google Sheets mirror** (optional). Supabase stays the source of truth.

Every lead's state is **automatic**. Nobody sets or edits a status:

| State | Colour | Meaning |
| --- | --- | --- |
| **CLICKED** | yellow | Clicked Book Free Demo but hasn't completed registration |
| **REGISTERED** | green | Completed the registration (even if they clicked first) |

## The flow

```
Landing page ──click "Book Free Demo"──► click tracked (CLICKED)
      │
      └─► redirect to register.aststraining.com/?…&sid=<visitor ID>#book
                │
                ├─ registration completed ─► REGISTERED (automatically)
                └─ leaves without registering ─► stays CLICKED
```

- The landing page sends visitors to `REGISTER_URL` (set in the page's
  `ASTS_CONFIG`, default `https://register.aststraining.com/#book`), passing
  their anonymous visitor ID as `?sid=` plus any `utm_*`/`gclid` tags.
- The registration page adopts that ID (then removes it from the address bar),
  so the click on one site and the registration on the other count as **one
  person**, even though browsers keep separate storage per site.
- On the registration site itself the buttons just scroll to the form (no
  redirect), so register.aststraining.com behaves exactly as before.
- Locally, `http://localhost:8080` is the landing page and
  `http://127.0.0.1:8080` plays register.aststraining.com.

**If the registration page is ever a different app:** it only needs to read
`sid` from its URL and send it as `session_id` when it posts the completed
registration to `POST /api/registrations`. The visitor then becomes REGISTERED
automatically.

## Quick start

Requires Node.js 20.12 or newer.

```bash
cd backend
npm install
npm start
```

- API: http://localhost:5000 (health check: http://localhost:5000/api/health)
- Dashboard: http://localhost:5000/dashboard/
- Landing page: run `node server.js` in the project root, then open http://localhost:8080

With no `.env` file the backend runs on a **local development database**: a
real PostgreSQL engine inside Node (PGlite) running the same
`supabase/schema.sql`. Its data is **in memory and is lost when the backend
restarts**. Add your Supabase keys to use the real database.

| Command            | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `npm start`        | Start the API                                       |
| `npm run dev`      | Start and auto-restart when you save a file         |
| `npm test`         | Run the automated tests (uses the local database)   |
| `npm run db:check` | Check the Supabase connection and schema            |

## Supabase setup

1. Create a project at https://supabase.com (free tier is fine).
2. **Create the tables:** open **SQL Editor → New query**, paste the whole of
   [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It is safe to
   run again later.
3. **Get the keys:** **Project Settings → API**. Copy the **Project URL** and the
   **service_role** key (not the anon key).
4. Copy `.env.example` to `.env` and set:
   ```
   SUPABASE_URL=https://<your-project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   ```
5. Run `npm run db:check`, then restart the backend. The startup log and the
   dashboard badge will say **Supabase**.

The service-role key bypasses Row Level Security, so it lives only in
`backend/.env` on the server. It is never sent to the landing page. RLS is
enabled on every table with no policies, and the functions can only be called
by `service_role`, so the public anon key can't read or write anything.

### Tables

| Table           | One row per                  | Columns |
| --------------- | ---------------------------- | ------- |
| `visitors`      | anonymous visitor (session)  | id, session_id (unique), page, source, device, visited_at |
| `events`        | tracked action               | id, session_id, event_type, page, created_at |
| `registrations` | completed registration (= REGISTERED) | id, session_id, submission_id (unique), name, phone, email, city, course, source, created_at, updated_at |

`event_type` is one of `page_view`, `demo_button_click`, `form_started`,
`registration_submitted`. `form_started` is limited to one per session by a
unique index.

## Google Sheets setup

1. **Create a service account:** https://console.cloud.google.com → create or
   pick a project → **APIs & Services → Library** → enable **Google Sheets API**.
   Then **IAM & Admin → Service Accounts → Create service account** (no roles
   needed) → open it → **Keys → Add key → JSON**. A `.json` file downloads.
2. **Create a Google Sheet** and **share it** with the service account's email
   (the `client_email` in the JSON, like `name@project.iam.gserviceaccount.com`)
   as **Editor**.
3. Set in `backend/.env`:
   ```
   GOOGLE_SHEETS_SPREADSHEET_ID=<the long ID in the sheet's URL>
   GOOGLE_SERVICE_ACCOUNT_EMAIL=<client_email from the JSON>
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```
   Copy `private_key` from the JSON exactly, keeping the `\n` sequences and the
   quotes. Or set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to the JSON file's path.
   Keep that file outside the project.
4. Restart the backend. On startup it creates the tabs, headers and colour
   rules. Then click **Sync now** on the dashboard to copy existing data.

**Tabs:** Visitors, Clicks, Registrations, Summary, and Clicked Not Registered.

- Visitors and Clicks: new rows are appended a few seconds after they happen.
- Registrations, Summary and Clicked Not Registered: rewritten from the database
  shortly after any change. When a clicker registers, they move from Clicked Not
  Registered to Registrations by themselves.
- An **Activity** column is written by the backend: `REGISTERED` on the
  Registrations tab, `CLICKED` on Clicked Not Registered. Conditional formatting
  colours the whole row: REGISTERED = green, CLICKED = yellow. There is no
  status to edit. The rules are recreated on each startup (older manual-status
  rules are removed).
- Session IDs appear as anonymous labels (e.g. `V-7F3A2C91`), the same as the dashboard.
- Values are written as plain text/numbers, never as formulas.
- If Google is unreachable, tracking and registrations still work. The
  dashboard shows the error, and **Sync now** rebuilds every tab.

## Environment variables

See [`.env.example`](.env.example). All are optional locally.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | API port |
| `NODE_ENV` | `development` | `production` requires Supabase and refuses admin access without a key |
| `FRONTEND_URL` | `http://localhost:8080,http://127.0.0.1:8080,http://localhost:4173` | CORS-allowed origins (comma-separated). In production include **both** the landing page and `https://register.aststraining.com` |
| `BODY_LIMIT` | `10kb` | Max JSON body |
| `TRUST_PROXY` | `0` | Proxies in front of the app (1 on Vercel) so rate limits see real IPs |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase connection (server-side only) |
| `ADMIN_API_KEY` | — | Protects the dashboard and admin endpoints |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | — | Enables Google Sheets sync |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` | — | Service-account credentials, or… |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | — | …path to the JSON key file |
| `REPORT_TIMEZONE` | `Asia/Kolkata` | Time zone for dates in the sheet |
| `RATE_LIMIT_TRACK_PER_MIN` | `120` | Tracking requests per IP per minute |
| `RATE_LIMIT_REGISTRATIONS_PER_10_MIN` | `10` | Registrations per IP per 10 minutes |

## Dashboard

Open **http://localhost:5000/dashboard/**.

- If `ADMIN_API_KEY` is set, it asks for the key once per browser tab.
  Generate a key with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Without a key, in development it opens directly (the startup log warns).

It shows the four stat cards (Total visitors, Demo clicks, Registrations,
Conversion rate), all six numbers, a funnel, leads by automatic state, daily
trends, the registrations table (read-only, all REGISTERED), and the
**Clicked but not registered** list. Filters: Today / Yesterday / Last 7 days /
Last 30 days / All time / Custom, plus course, city, source, and a Status
filter that shows the Registered or Clicked list. It
refreshes every 30 seconds.

## How the numbers are counted

- **Visitor ID:** the landing page creates a random ID on the first visit and
  keeps it in the browser (`localStorage`). No name, IP address or raw referrer
  is stored for tracking, only the coarse `source` (utm_source, `google_ads` for
  Google Ads clicks, the referring site, or `direct`) and `device`
  (mobile/tablet/desktop). Known bots are ignored.
- **Unique visitors** = distinct visitor IDs active in the date range.
  **Page views** = every `page_view`, so 5 refreshes = 1 visitor and 5 page views.
- **Demo clicks:** every click on a "Book Free Demo" button (header, demo band,
  footer and the form's submit button) is stored. **Total clicks** counts them
  all. **Unique clickers** counts distinct visitor IDs.
- **Form starts:** recorded the first time a visitor types in the form. Once
  per visitor (in the browser and enforced by the database).
- **Registrations:** stored only after the backend validates and saves them.
  The `registration_submitted` event is written by the server in the same
  database transaction, never by the browser. Failed validation stores nothing.
- **Conversion rate** = registrations ÷ unique visitors × 100 (never ÷ clicks).
- **Automatic state per person:** REGISTERED if their visitor ID has a
  completed registration, otherwise CLICKED if they clicked Book Free Demo. Each
  person appears once, so clicked-then-registered is only **REGISTERED (green)**.
  Nothing is ever set by hand.
- **Duplicate submissions:** each form submission carries a `submission_id`.
  A double-click or retry resends the same ID and gets back the existing
  registration (HTTP 200, `"duplicate": true`) instead of creating a new one. A
  later, separate submission from the same person is a new registration.
- **Filters:** date and source apply to everything. Course and city
  apply to registration numbers (visits and clicks have no course or city).

## API

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | public | Health check |
| POST | `/api/track` | public | Tracking event from the landing page |
| POST | `/api/registrations` | public | Submit a registration |
| GET | `/api/registrations` | admin | List (newest first). Optional `?from&to&course&city&source` |
| GET | `/api/registrations/:id` | admin | One registration |
| DELETE | `/api/registrations/:id` | admin | Delete |
| GET | `/api/admin/session` | admin | Checks the key; reports database type |
| GET | `/api/admin/dashboard` | admin | All dashboard numbers. `?from&to&tz&course&city&source` |
| GET | `/api/admin/clicked-not-registered` | admin | Clicked-but-not-registered visitors. `?from&to&source` |
| GET | `/api/admin/sheets` | admin | Google Sheets sync status |
| POST | `/api/admin/sheets/sync` | admin | Rebuild every sheet tab now |

Admin requests send `Authorization: Bearer <ADMIN_API_KEY>`.

**POST /api/track**

```json
{ "session_id": "3abad814-27e5-4833-8456-6bb21abec757", "event_type": "demo_button_click", "page": "/", "utm_source": "google", "referrer": "https://www.google.com/" }
```

`event_type`: `page_view`, `demo_button_click` or `form_started`. Returns `202`.

**POST /api/registrations**

```json
{
  "name": "Rahul", "phone": "9876543210", "email": "rahul@gmail.com",
  "city": "Hyderabad", "course": "Oracle EPBCS",
  "session_id": "optional visitor ID", "submission_id": "optional one-per-submission ID"
}
```

`201` created · `200` same `submission_id` already saved (`"duplicate": true`) ·
`400` validation failed (`errors` per field) · `429` too many requests.

Registration fields: **name** (2–80 letters), **phone** (8–15 digits, optional
`+`), **email** (optional, valid format), **city**, **course** (required).
Unknown fields (including any `status`) are ignored. A saved registration makes
the visitor REGISTERED; there is no endpoint to change that by hand.

### Testing with curl (Git Bash)

```bash
curl http://localhost:5000/api/health
curl -X POST http://localhost:5000/api/track -H "Content-Type: application/json" \
  -d '{"session_id":"test-session-001","event_type":"page_view"}'
curl -X POST http://localhost:5000/api/registrations -H "Content-Type: application/json" \
  -d '{"name":"Rahul","phone":"9876543210","email":"rahul@gmail.com","city":"Hyderabad","course":"Oracle EPBCS","session_id":"test-session-001"}'
curl http://localhost:5000/api/admin/dashboard -H "Authorization: Bearer $ADMIN_API_KEY"
```

In Windows PowerShell use `Invoke-RestMethod` (PowerShell's `curl` is a different command).

## Project structure

```
backend/
├── public/dashboard/        # Dashboard page (HTML, CSS, JS; no build step)
├── scripts/db-check.js      # npm run db:check
├── src/
│   ├── config/              # Environment variables, constants
│   ├── controllers/         # HTTP in/out only
│   ├── db/                  # Supabase or local PostgreSQL, same rpc() interface
│   ├── integrations/        # Google Sheets API client
│   ├── middleware/          # Validation, admin key, rate limits, errors
│   ├── repositories/        # Calls the SQL functions, maps rows
│   ├── routes/              # /api/track, /api/registrations, /api/admin
│   ├── services/            # Registration, tracking, analytics, Sheets sync
│   ├── utils/               # Validation rules, device/source detection
│   ├── app.js               # Express app
│   └── server.js            # Starts the server
├── supabase/schema.sql      # Tables, indexes, functions, permissions
├── tests/                   # npm test
├── .env.example
└── package.json
```

Request flow: route → validation → controller → service → repository → SQL
function. All counting logic lives in `supabase/schema.sql`, so the dashboard,
Google Sheets and tests all use the same numbers.

## Security notes

- Secrets only come from environment variables. `.env` and service-account key
  files are git-ignored.
- The service-role key and the Google private key are only used server-side.
- Helmet headers, CORS limited to `FRONTEND_URL`, 10 KB body limit, per-IP rate
  limits on the public endpoints, strict validation with field whitelisting.
  Errors never include stack traces or SQL details.
- Admin endpoints require `ADMIN_API_KEY`. **Set it before deploying.** In
  production, admin endpoints refuse to work without it.
- On a serverless host (e.g. Vercel), background Sheets updates may be cut off
  when a request ends. Use **Sync now** or schedule `POST /api/admin/sheets/sync`
  (with the admin key) to keep the sheet complete.
