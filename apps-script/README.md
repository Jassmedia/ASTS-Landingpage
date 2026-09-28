# ASTS: Google Sheet + Apps Script + Admin Dashboard

One Google Apps Script Web App and one Google Sheet run everything. The Sheet is
the only source of truth.

```
Visitor ──► https://register.aststraining.com/ ──POST──► Apps Script Web App ──► Google Sheet
                                                          (Code.gs)                (private)
Admin Dashboard (admin/) ──────────────────────POST──►  same Web App        ◄── same Sheet
```

| File | What it is |
| --- | --- |
| `apps-script/Code.gs` | The complete Apps Script. Paste it into the Sheet's Apps Script editor. |
| `index.html`, line 17 | Registration website: `ASTS_CONFIG.APPS_SCRIPT_URL` |
| `admin/config.js`, line 8 | Admin Dashboard: `ADMIN_CONFIG.APPS_SCRIPT_URL` (the same URL) |
| `admin/` | The private dashboard (static files, no data or secrets inside) |

The Node backend in `backend/` is **not** used by this setup and was left untouched.

---

## 1. Google Sheet structure

Two tabs. `setup()` creates both with these exact headers (step 7 below).

### Tab `Events`: one row per tracked action

| Column | Contents |
| --- | --- |
| Event ID | Random unique ID |
| Event Type | `page_view`, `demo_button_click`, `form_started` or `registration_submitted` |
| Visitor ID | Random ID kept in the visitor's browser (never the IP address) |
| Session ID | One visit; a new one starts after 30 minutes without activity |
| Timestamp | When the Apps Script saved the event |
| Page URL | Page address, including any `utm_*` / `gclid` in it |
| UTM Source, UTM Medium, UTM Campaign | Campaign tags from the link (or remembered from an earlier ad click) |
| GCLID | Google Ads click ID |
| Device | `desktop`, `mobile` or `tablet` |
| Browser | Chrome, Edge, Safari, Firefox, … |

`registration_submitted` is written by the Apps Script itself, in the same request
that saves the registration, so it only ever exists for a registration that was saved.

### Tab `Registrations`: one row per saved registration

| Column | Contents |
| --- | --- |
| Registration ID | e.g. `ASTS-20260928-7F3A1C` (date in the Sheet's time zone) |
| Visitor ID, Session ID | Link the registration to the visitor's earlier visits and clicks |
| Name, Phone, Email, City | From the form. Phone = country code + number, digits only (e.g. `919876543210`) |
| Course | `Oracle EPBCS` (or the `?course=` from the link) |
| Country, Country Code | From the phone country picker (e.g. `India`, `IN`) |
| Consent | `Yes` (the form cannot be sent without it) |
| UTM Source, UTM Medium, UTM Campaign, UTM Term, GCLID | Attribution saved with the registration |
| Page URL, Device, Browser | Where and on what it was submitted |
| Submission ID | Stops a double-click or retry from saving the same registration twice |
| Submitted At | When the Apps Script saved it (the visitor's device clock is not trusted) |

Notes:
- Do not rename the tabs or the header names. Reordering columns is fine.
- All text is stored as plain text, so a value like `=IMPORTXML(...)` can never run as a formula.
- Keep the Sheet **private**. Do not share it or "publish to web". The web app reads
  and writes it on your behalf.

---

## 2. Deploy the Apps Script

1. **Create the Google Sheet.** Go to https://sheets.new and name it, for example,
   `ASTS Registrations & Tracking`. Then set its time zone: **File → Settings → Time zone →
   (GMT+05:30) India Standard Time → Save settings**.
2. **Create the required tabs.** `setup()` creates `Events` and `Registrations`
   with the exact headers in step 7, so there is nothing to type. (The empty `Sheet1` can be deleted afterwards.)
3. **Open Extensions → Apps Script.**
4. **Paste the code.** Delete everything in `Code.gs` (the sample `function myFunction() {}`),
   then paste the **entire** contents of `apps-script/Code.gs` from this project.
   Optionally rename the project (top left) to `ASTS Tracking`.
5. **Save** (Ctrl+S / ⌘S).
6. **Authorize** by running the setup: in the toolbar, choose **`setup`** in the function list,
   then click **Run**. Google asks for permission:
   **Review permissions → choose your account → "Google hasn't verified this app" → Advanced →
   Go to ASTS Tracking (unsafe) → Allow.** (It is your own script; it only gets access to this one
   spreadsheet because of the `@OnlyCurrentDoc` line.)
7. **Check the setup.** The execution log shows `Created ADMIN_KEY…` and `Setup complete…`. The Sheet now
   has the `Events` and `Registrations` tabs with bold, frozen headers.
8. **Script Properties (the secret).** Click **Project Settings** (gear icon, left) → scroll to
   **Script properties**. You will see `ADMIN_KEY` with a 64-character random value. **Copy it and
   keep it in your password manager.** This is the password for the Admin Dashboard.
   (You may replace it with your own value of at least 24 characters. Never put it in any file.)
9. **Deploy → New deployment.** Click the gear next to "Select type" and choose **Web app**.
10. Fill in: Description `ASTS v1` · **Execute as: Me** · **Who has access: Anyone**.
11. Click **Deploy**. If Google asks to authorize again, repeat the steps from step 6.
12. **Copy the Web app URL.** It looks like `https://script.google.com/macros/s/…/exec`.
    Use the one that ends in **`/exec`**, not the `/dev` test URL.
    **Paste the real /exec URL here:** `index.html` line 17 and `admin/config.js` line 8 (sections 3 and 4).
13. **Check that it answers:** open the `/exec` URL in your browser. You should see
    `{"success":true,"service":"ASTS registrations and tracking","status":"ok",…}`.
    It contains no data; everything else needs POST requests.

### Changing the script later (keeps the same URL)

After editing the code in Apps Script: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
Don't use "New deployment" again, because that creates a different URL.

---

## 3. Connect the registration website

File **`index.html`**, **line 17**, inside `window.ASTS_CONFIG`:

```js
    APPS_SCRIPT_URL: 'PASTE_YOUR_WEB_APP_URL_HERE',
```

Replace only the text between the quotes with your real `/exec` URL, keeping the quotes and the comma.
Then publish the site the way you normally do. Until the real URL is there, tracking is off and
the form says "The form is not connected yet".

## 4. Connect the Admin Dashboard

File **`admin/config.js`**, **line 8**:

```js
  APPS_SCRIPT_URL: 'PASTE_YOUR_WEB_APP_URL_HERE'
```

Paste the **same** `/exec` URL as in `index.html`. There is only one Apps Script URL.

Open the dashboard over `http://`, not by double-clicking the file (browsers limit pages opened from disk):

- On your computer: run `node server.js` in the project folder and open **http://localhost:8080/admin/**
  (keep the trailing slash).
- Or host the `admin/` folder on any static host. The page holds no data and no secrets, and search
  engines are told not to index it. If you publish the whole project folder, it will be at
  `/admin/` on that site; all data still requires your admin key.

## 5. How the dashboard authenticates

- The admin key exists in one place: **Apps Script → Project Settings → Script properties → `ADMIN_KEY`**.
  It is not in GitHub, the website, the dashboard files, a URL, or localStorage.
- You type it on the dashboard's sign-in screen. It is kept only in a JavaScript variable in that
  browser tab (not localStorage, sessionStorage or cookies). Reloading or closing the tab signs you out.
  Your browser's password manager may offer to remember it; that is your choice.
- Every dashboard request is a **POST** to the `/exec` URL with the key inside the JSON body,
  encrypted by HTTPS. The script compares it with `ADMIN_KEY` before it reads the Sheet. A wrong or
  missing key gets `Wrong admin key.` and no data.
- **Why POST instead of GET:** Apps Script cannot read request headers, so a GET request could
  only carry the key in the URL, where it would end up in browser history and server logs. So `doGet`
  only answers the health check in step 13, with no data.
- The website's requests (`track`, `register`) need no key. They can only add rows, never read them.
- If the key is ever exposed: in the Apps Script editor, run **`rotateAdminKey`**, then copy the new
  value from Script properties. The old key stops working immediately.

---

## 6. Test the complete flow

Use a **new private/incognito window** as the "visitor" (a fresh visitor ID), and keep that same window
open for tests 5 and 6. Keep the dashboard open in a normal window. Afterwards, delete the test rows from both tabs
(delete rows 2 and below only, never the header row).

| # | Do this | Expect |
| - | --- | --- |
| 1 | Open https://register.aststraining.com/ | `Events` gets a `page_view` row with a Visitor ID and Session ID |
| 2 | Click **Book Free Demo** (top bar) | A `demo_button_click` row, same Visitor ID |
| 3 | Type in the first form field | One `form_started` row (only once per visit) |
| 5 | Stop here, then look at the dashboard | **Clicked But Not Registered** = 1; the visitor is listed under Tracking → Clicked but not registered |
| 4 + 6 | In the same window, complete the form and submit | The page shows **🎉 Registration Successful!** A new `Registrations` row appears, plus a `registration_submitted` event. The dashboard shows the registration, and the visitor moves to **REGISTERED** (Clicked But Not Registered goes back down) |
| 7 | Refresh the website a few times | **Total Visitors** goes up with each refresh; **Unique Visitors** does not |
| 8 | Leave the dashboard open and repeat test 1 from another private window | Within 30 seconds, without reloading, the numbers and **Last Updated** change |

Also worth trying once: submit with the **Anyone** access switched off, or with a wrong URL. The page must show
an error, keep everything that was typed, and never show "Registration Successful".

For Google Ads attribution, open the site with tags, for example
`https://register.aststraining.com/?utm_source=google&utm_medium=cpc&utm_campaign=test&gclid=TEST123`,
then register. The row shows those values, and Analytics → *Campaigns and sources* credits them.

---

## 7. What each number means

| Dashboard | Definition (for the selected period) |
| --- | --- |
| Total Visitors | All `page_view` events: every page load, refreshes included |
| Unique Visitors | Different Visitor IDs seen |
| Demo Button Clicks | All `demo_button_click` events (the Book Free Demo buttons, including the form's submit button) |
| Unique Clickers | Different Visitor IDs that clicked |
| Form Starts | Different Visitor IDs that started typing in the form |
| Registrations | Rows in `Registrations` |
| Conversion Rate | Registrations ÷ Unique Visitors |
| Clicked But Not Registered | Visitor IDs that clicked in the period and have **never** registered (a later registration counts, even outside the period) |

Periods (Today, Yesterday, Last 7 Days, Last 30 Days, This Month, All Time, Custom) use the time zone of
the computer showing the dashboard. The dashboard polls every 30 seconds while it is on screen, pauses while
the tab is hidden, and catches up as soon as you come back.

## 8. Visitor identity and its limits

- **Visitor ID** is a random ID stored in the browser (`localStorage` key `asts_sid`). Refreshing, leaving and
  returning later, or registering days after clicking all keep the same ID in the same browser. The IP address is not used.
- **Session ID** is one visit. A new one starts after 30 minutes without activity.
- If "Book Free Demo" is clicked on a different site that uses this same page, the link to the registration site carries
  `?ref=<Visitor ID>`, so both sites count one person. The ID is removed from the address bar right away.
- Where it is technically impossible to link people: a different browser or device, private windows
  that were closed, cleared browser data, or tracking blocked by a privacy extension. Such a person gets
  a new Visitor ID. Registrations themselves are never blocked by this.

## 9. Google Ads attribution

`utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `gclid` are read from the landing URL and
remembered for 90 days in first-party cookies (`asts_utm`, `asts_gclid`). A visitor who clicks an ad, leaves,
and comes back directly is still credited to that ad. They are saved on every event and on the
registration. Nothing is guessed: a tag that never arrived shows as "(not set)". In Google Ads, keep
auto-tagging on (for `gclid`) and add a **Final URL suffix** such as
`utm_source=google&utm_medium=cpc&utm_campaign=epbcs-search` so each campaign is named.

## 10. Limits worth knowing

- Anyone can send data to a public web app (true for any public form). Validation, the hidden spam field
  and duplicate protection limit this; reading data always needs the admin key.
- A Google account runs about 30 Apps Script executions at the same time. Each page view is one, which is
  plenty for normal ad traffic. In an extreme burst a few tracking events can be dropped. A registration
  that fails shows an error and can simply be sent again.
- A spreadsheet holds up to 10 million cells (about 800,000 `Events` rows). The dashboard reads the
  whole `Events` tab on each refresh, so once it reaches tens of thousands of rows, move old rows to an
  archive spreadsheet to keep it fast.

## 11. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Form says "The form is not connected yet" | `index.html` line 17 still has the placeholder |
| Form says "We couldn't reach our registration system" | Check the `/exec` URL. Check the deployment has **Who has access: Anyone**. After code changes, deploy a **New version** |
| Dashboard says "Wrong admin key" | Copy `ADMIN_KEY` again from Script properties (no spaces) |
| Dashboard says "The dashboard is locked" | Run `setup` once, or set `ADMIN_KEY` (24+ characters) in Script properties |
| Dashboard page stays on "Loading…" | Open it through `http://` (section 4), not by double-clicking the file |
| Code changes have no effect | Deploy → Manage deployments → Edit → **New version** |
