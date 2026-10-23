# CLAUDE.md

The customer order page, branded **Figure It** (www.figureit.co.il), for **Life2Print**, the operator's app (a private sibling
repo, `E:\Git\Life2Print`, with its own CLAUDE.md). Customers order 1–10 figurines at once, each from a pet photo or a child's
drawing with 1–3 photos, and choose self-pickup or delivery to a pickup point. The page saves the order to Supabase, uploads
the photos, and sends the customer to the Grow payment page. Life2Print syncs the orders; the operator confirms payment by
hand and makes the models. This repo is **public** (GitHub Pages from a private repo needs a paid plan), and so is
everything in `site/`.

Built on 2026-10-18 from one design spec by four agents working in parallel: the site (`site/`), this repo's schema, tests,
scripts and docs, and Life2Print's server and Orders tab. On 2026-10-22 an order went from one figurine to 1–10 (`items`),
the delivery choice was added, the prices became per order size, and the brand became Figure It (the owner's choices).
On 2026-10-23 the price for 2 or more and its Grow coupon were dropped: every figurine costs the same.
**The docs were written alongside the code, not after it**: check what they say against the code, and fix whichever is
wrong. As of 2026-10-22 the owner had created the Supabase project and run the first version of schema.sql, and Life2Print
syncs from it; nothing had run against a real Grow page or GitHub Pages yet (see Open questions). See README.md for the
layout and SETUP.md for the owner's steps.

## Commands

```sh
npm install
npm start      # http://localhost:8080/life2print-site/ (PORT to change)
npm test       # supabase/schema.sql in PGlite: no network, no Supabase project
npm run check  # before every commit: deploy.yml's key rules on every file to be committed, and site/*.js load
```

No build step, bundler or linter; `site/` is published byte for byte, apart from deploy.yml's `__V__` stamp.
`npm run check` (`scripts/check.mjs`) uses only Node built-ins, so it works before `npm install`.
The only dependency is `@electric-sql/pglite`, pinned to exactly 0.5.8 (a devDependency, for the test).

## Rules

- **Secrets:** only public values go in `site/`: the project URL and the publishable key (`sb_publishable_…`, role anon).
  The secret key (`sb_secret_…`, or a legacy `service_role` JWT) bypasses RLS and exposes every customer's details and photos.
  It lives only in Life2Print's git-ignored `SupabaseAPI.txt`. Never create that file, print a key, or put one in this repo.
  Guards: app.js refuses to open orders with one (`isPublishableKey`, which decodes a JWT's role); `config.js` must not
  even mention `sb_secret_` or `service_role` (reword comments instead); `npm run check` applies deploy.yml's three rules
  to every file a commit would include; and deploy.yml fails on one. **The deploy guard runs after the push**, on a public
  repo, so a key it catches is already in the git history: it limits the damage (the live site isn't updated) rather than
  preventing the leak, and its messages say to rotate the key. Only `npm run check` before the commit prevents it.
- **Real money and real data:** a push to `main` deploys the live site within a minute or two. Grow payments are real
  (Bit, Apple Pay and Google Pay have no sandbox). Don't place orders in the real Supabase project or pay on Grow to test:
  `npm test` covers the database rules, and app.js accepts an `http://localhost` Supabase URL for a mock.
  A local preview with the real `config.js` places real orders.
- **Free plan:** 500 MB database, 1 GB storage, 5 GB egress a month; paused after 7 idle days (Life2Print's 30 s sync keeps it
  awake). Don't add anything that polls Supabase from the site or reads rows back.
- **Constraint names are an interface.** app.js finds the field to blame by the column name inside the constraint name
  (`orders_<column>_<rule>`, e.g. `orders_phone_format`; only customer_name, phone, email, address, delivery and notes map
  to a field, and `orders_items_valid` gets the general message) and tells `orders_pkey` from `orders_code_key` on 23505;
  Life2Print turns 23505 on `orders_payment_ref_key` into "already on order NNNNNN". Renaming one means changing those too.
- **Schema changes:** `alter table public.orders add column if not exists …` below the `create table`, never an edit inside it
  (see Lessons from nostalgia). Constraints: `drop constraint if exists x, add constraint x check (…)`. Then `npm test`,
  and the owner re-runs the whole file in the SQL editor. A new column the browser sends also needs adding to anon's insert grant.
  The 2026-10-22 change shows the pattern for a change of shape: the `create table` holds the new shape for a new project,
  and a block below it (`do $$ … if the old column exists …`) moves an existing table's rows over, idempotently. Its test
  builds a first-version table and runs the file on it twice.
- **The row shape is shared with Life2Print** (`server/orders.js` `usableRow` and `view`, `public/app.js`'s Orders tab):
  change `items`, `delivery` or the photo numbering on both sides.

## How an order flows

1. **Config:** `site/config.js` (an ES module, committed). Orders are closed ("ההזמנות ייפתחו בקרוב", `console.warn` naming
   what's missing) until it has the URL (https, or http on localhost for a mock), the publishable key and a contact phone or
   email. `prices` (`figurine`: each figurine, however many; `pickupPoint`: delivery), `growUrl` (one Grow page for
   every order), `growItems` (its product per kind) and `growShipping` (its "משלוח" field's two options), so the
   confirmation can say what to choose, `pickupFrom`, `deliveryDays`, `business`. No `growUrl`: the confirmation says
   we'll be in touch. A `growUrl`
   that isn't an absolute https link, or a price that isn't a plain number, counts as unset, with a `console.warn` (and a
   warning from `npm run check`).
   - **Prices:** total = `figurine × n`, plus `pickupPoint` for delivery (`orderTotal`). The form shows it live under the
     fields (`#total`), and the row stores it as `price_ils`.
   - **Grow steps** on the confirmation and the pending panel (`renderPayment`, `growSteps`): the product for each kind
     with its quantity (only when `growItems` names every kind in the order; the stored order keeps `kinds` for this), the
     shipping option, then always the total to check and the code to paste into "מספר הזמנה".
   - **Closed is the default in index.html** (the notice visible, `#fields` disabled), and app.js opens the form. So a
     config.js or app.js that fails to load leaves the notice, not a form that looks open but can't be sent. The usual
     cause is a Hebrew abbreviation typed with an ASCII apostrophe inside `'…'` (`'רח' הרצל'`): config.js's header and
     SETUP step 8 say to use ׳ and ״ or backticks, and `npm run check` and deploy.yml catch it.
     While app.js loads, an inline script in index.html's head puts `opening` on `<html>`, which hides the notice (it
     flashed on every load until 2026-10-23); init() removes it. A script `error` (a failed fetch or import, a syntax
     error, init() throwing) removes it at once, and a 6 s timeout if app.js never arrives.
2. **Figurines:** `ol#figurines`, one `li.figurine` per figurine cloned from `template#figurine-template` (`addFigurine`).
   Each has a key (`fig1`, `fig2`, …, never reused) that names its ids, radio group and field keys (`fig2-kind`,
   `fig2-photos`, `fig2-subject`, `fig2-personality`), so errors and labels never mix; its number on the page (`פסלון 2`)
   follows removals (`renumberFigurines`). Up to `MAX_FIGURINES` (10, as the database allows), 1–3 photos each. Removal is
   offered from two figurines up; a figurine removed while its photos are being prepared is marked `removed`, and the pick
   is dropped.
   - **"אופי"** (the pet's character, optional, up to 200 characters; the owner's request, 2026-10-23) shows beside the
     name only once the figurine is a pet (`updateKind`). Text typed before switching to a drawing stays in the hidden
     field and isn't sent: a drawing's `personality` is always null.
   - **Function declarations, not arrow constants**, for anything init() reaches: init() runs at the top of the module,
     before a `const` further down is initialised (2026-10-22: `const deliveryValue = () => …` threw on load, and the page
     stayed closed).
3. **Photos:** decoded one at a time across all figurines (`createImageBitmap`, which applies EXIF rotation; never
   `Promise.all`, for phone memory), drawn at most 2048 px on white, JPEG 0.9, re-encoded at 0.8 then 0.7 while over 3.5 MB.
   A 192 px thumbnail is drawn from the same decode: showing the 2048 px JPEGs would keep up to 30 full decodes in memory.
   `accept="image/*"` exactly. The upload numbers them on through the order: figurine 1's photos first.
4. **Delivery:** radios `delivery` = `pickup` (free, from `pickupFrom`, by arrangement) or `pickup_point` (+`prices.pickupPoint`);
   the address shows only for `pickup_point`, and the row has `address: null` for pickup. Since 2026-10-23 it's two fields,
   street and number (`autocomplete="address-line1"`) and city (`address-level2`), so browsers fill in a saved address;
   the row still has one `address`, "<street>, <city>" (2–200 and 2–100 characters, within the database's 5–500).
   A database refusal of the address is shown on the street.
5. **Submit:** an attempt (`newAttempt`) is the row (`id: crypto.randomUUID()`, a 6-digit `code`, the fields: `items`
   `[{ kind, subject_name, personality, photos }]`, `delivery`, `address`, `photo_count`, `price_ils`, …), every figurine's photo Blobs
   in order, and `inserted`, `unknown`, `assumed`, `uploaded`, `startedAt`, `rowAt`; made once and kept across retries.
   - Insert: `POST /rest/v1/orders`, `Prefer: return=minimal`, only the 12 granted columns, 20 s timeout. Outcomes:
     saved (201); unknown (network error, timeout, 5xx: retry with the same id and code); exists (23505 naming `orders_pkey`:
     an earlier try was saved); code-taken (23505 naming `orders_code_key`: new code, same id, up to 3 times);
     busy (P0001, the insert guard); invalid (other 4xx: the constraint name points at a field).
   - Uploads: `POST /storage/v1/object/order-photos/<id>/<n>.jpg`, raw JPEG body, `x-upsert: false`, 120 s timeout.
     Storage answers errors with HTTP 400 and the real code in the body's `statusCode`: '409' means already stored (success);
     '403' means the bucket's rule refused the photo.
   - **Upload 403:** a fresh attempt (new id and code, from the photos and fields the page still holds) only when this
     row can't take photos any more: it is at least 55 minutes old (`UPLOAD_WINDOW_MINUTES`; the age runs from `rowAt`, the
     earliest the row can have been created by this device's clock, so it overstates the age and under 55 the bucket's hour
     can't have passed), or the insert was only assumed saved (`assumed`: a code clash after a lost answer, so the row may
     be someone else's) and nothing was uploaded yet. At most one automatic restart per click, and its "שולחים את ההזמנה
     מחדש…" is passed to insertOrder so it isn't overwritten in the same task. Any other 403 refuses every order alike (the
     storage fallback policy missing, the bucket at 800 MB): a new row would only add a photo-less order and use up the
     shop-wide hourly cap. So the page keeps the same row and code, shows an error with the contact details, and a retry
     uploads into the same order. The console names both likely causes.
6. **Confirmation:** the summary (`3 פסלונים · משלוח לנקודת איסוף · סה״כ ₪475`), the code (copy button) and the Grow button:
   a link that opens Grow in a new tab (the owner's request, 2026-10-23; it was same-tab) and copies the code to the
   clipboard inside the click, with the Grow steps under it. This tab stays on the confirmation, and a `storage` listener
   runs `refreshRestoredPage` when another tab changes the stored order: Grow's `?paid` redirect, landing in Grow's tab,
   turns this one into the thank-you note. The pending panel's Pay button opens a new tab too (`renderPayment` draws both).
   localStorage `figureit-order` keeps `{ code, paymentUrl, count, delivery, total, at, paidClaimed }` (every access in
   try/catch), so Back from Grow, a reload or an evicted tab shows the pending panel for 24 hours unless `paidClaimed`.
   - **The panel can't know whether they paid**, so it's neutral: "ההזמנה האחרונה שלכם: <code>", "אם עוד לא שילמתם, אפשר
     לשלם כאן. כבר שילמתם? אין צורך לשלם שוב…" with the contact details, the Pay button, and "כבר שילמתי / הסתרה", which sets
     `paidClaimed` and keeps the code (the form is right below, so no "new order" button is needed).
   - **Back/forward cache:** Back from Grow, or from the thank-you note, can restore the page exactly as it was left
     without running init(). A `pageshow` handler (`refreshRestoredPage`) checks the stored order again: a confirmation
     whose order is now paid-claimed becomes the thank-you note, one still pending becomes the panel above a fresh form,
     and on the form the panel shows or hides by the stored order.
7. **`?paid`:** Grow's thank-you redirect (SETUP step 7 calls it strongly recommended: it's the only thing that sets
   `paidClaimed` without the customer's click), matched with `/[?&]paid(?=$|[=&?])/` because Grow may append parameters.
   It carries no data and confirms nothing: the note repeats the stored code (if under 7 days old) and says what happens next.

Why it's built this way:
- **The row goes first, then the photos:** the browser can't read the table back, so it makes the id itself, and the bucket
  only takes photos into the folder of a 'new' order created in the last hour.
- **A failed save blocks payment** (unlike nostalgia, where a lead form let the visitor pay anyway): without photos there's
  nothing to make. So every error state offers a way forward: a retry, and the contact details.
- **Plain fetch, no supabase-js:** one insert and a few uploads don't justify a 100 KB library from a CDN, and the exact
  headers matter (`Prefer: return=minimal`, a raw JPEG body; supabase-js sends a Blob as multipart).
  Both keys go out as `apikey` and as `Authorization: Bearer` with the identical value (allowed for the new keys, required for legacy JWTs).
- **Order codes** are 6 digits not starting with 0: typed on a Hebrew phone keyboard into a field called "order number",
  and safe in a numeric field or a spreadsheet.

## The database (`supabase/schema.sql`)

- **The row:** `items` jsonb lists 1–10 figurines `{ kind: 'pet' | 'drawing', subject_name: 1–80 trimmed characters or
  null, personality: for a pet 1–200 trimmed characters, else null, photos: 1–3 }` (exactly those keys, except that
  `personality` may be missing: it came on 2026-10-23, the rows before lack it, and every update checks them again),
  checked by `orders_items_valid`, which calls `private.order_items_valid(items,
  photo_count)`: a plpgsql function that never raises (anything malformed is false) and needs their photos to add up to
  `photo_count` (1–30). `delivery` is `pickup` or `pickup_point`; `orders_address_delivery` wants an address exactly for
  `pickup_point` (and leaves an unknown delivery to `orders_delivery_check`, so the refusal names the right column).
  - **A check constraint runs its function as the writer**, so anon (insert) and service_role (every update re-runs every
    check) have EXECUTE on `order_items_valid`; authenticated and PUBLIC don't. `test.mjs` checks both grants.
- **anon** (the publishable key) has column-level INSERT on 12 columns and nothing else: no SELECT, UPDATE or DELETE grant
  or policy. Naming any other column, even as null, is 42501, so status, paid_at, payment_ref, job_ids, created_at and
  updated_at always take their defaults. The policy `orders_anon_insert` checks them again. Upserts fail (they need SELECT or UPDATE).
  A column revoke under a table-level grant restricts nothing, hence `revoke all` first.
- **service_role** gets explicit grants: Supabase projects created since 2026-05-30 (all of them from 2026-10-30) get no
  automatic grants in `public`, and a missing grant is 42501 even for service_role.
- **Insert guard:** an AFTER INSERT FOR EACH STATEMENT trigger (`referencing new table as new_rows`) raises P0001
  `orders_rate_limit` when one statement inserts more than 1 row (PostgREST inserts a JSON array as one statement) or more
  than `max_orders_per_hour` (20) orders exist from the last hour. A policy can't do this: the functions it calls see the
  table as it was before the statement, so a bulk insert passes a count check (the design review measured that in PGlite).
- **updated_at:** a BEFORE UPDATE trigger sets it from the database clock; Life2Print syncs by it (`updated_at=gte.<cursor − 2 min>`).
- **payment_ref:** unique where not null (`orders_payment_ref_key`): one Grow payment can't be recorded on two orders.
- **An exact retry** (same id and code) fails on `orders_pkey`, not `orders_code_key`: Postgres checks the primary key's index
  first whatever order the constraints are declared in (tested both orders). The site relies on it.
- **Regexes have no backslashes** (`[.]`, a hyphen last in a class), so they survive being copied into JS strings: with `\.`
  passed through a JS string, `1xjpg` matched. app.js mirrors them, with `\s` for Postgres's `[:space:]`.
- **`private` schema** for the SECURITY DEFINER functions: the API serves only `public`, so they can't be called as RPCs.
  - `can_upload_order_photo(name)` is true only for `<uuid>/<n>.jpg` with 1 ≤ n ≤ photo_count (n without a leading 0, at most
    two digits), an order that is 'new' and under an hour old, and a bucket under 800 MB. It never raises: the folder is cast
    to uuid only after a regex match, and `substring()` gives null otherwise.
  - **anon needs EXECUTE** on it, because the storage policy runs as anon. Supabase's Security Advisor may suggest revoking it; don't.
    USAGE on the schema is granted too, though Postgres doesn't check it when a stored policy runs (checked in PGlite).
  - The trigger functions have EXECUTE revoked: Postgres doesn't check it when a trigger fires (tested) and refuses direct calls.
- **The 800 MB cap fails open** if the function's owner (`postgres`) lacks BYPASSRLS: RLS on storage.objects would hide every row,
  the sum would be 0, and uploads would carry on to the plan's 1 GB. SETUP.md step 3 has the check.
- **Bucket `order-photos`:** private, 4 MB per file, `image/jpeg` only. Storage checks the type from the request's Content-Type
  header, not the bytes, so Life2Print checks the JPEG signature and dimensions after downloading.
- **Storage fallback policy** (SETUP.md step 14, not applied): Supabase's docs say an upload needs only an INSERT policy, and
  storage-api's source agrees, but one troubleshooting page says uploads read the row back. If the first real upload fails with an
  RLS error, add the select-during-upload policy, then add it to schema.sql and note it here.

## Testing

- **`npm test`** (`supabase/test.mjs`, plain node + `node:assert`): stubs Supabase's roles (`service_role` with BYPASSRLS) and a
  minimal `storage` schema (`buckets`, `objects` with `metadata` jsonb, `foldername`, `filename`, `allow_only_operation`), runs
  schema.sql twice, then replays PostgREST's insert (`insert … select … from json_to_recordset($1) returning 1`, as anon in a
  transaction) and storage-api's plain insert. 42 tests, among them 30 bad values that must each name their constraint, 25
  malformed `items` lists that must each be refused as `orders_items_valid`, figurines without the `personality` key (as
  the site sent before 2026-10-23), the delivery/address rule, a 30-photo order, the
  upgrade of a first-version table (run twice), the pkey-vs-code retry case, the 21st order in an hour (with the window
  pinned at 59 and 61 minutes), every refused upload path,
  the 800 MB cap at its boundary, RLS and the insert policy as a second layer behind the column grants (a mistaken column or
  select grant inside a rolled-back transaction), `search_path` and SECURITY DEFINER on every function in `private` (a complete
  list, so a new function fails until it's added), and a third run of schema.sql that resets hand-made grant and bucket changes.
  It also runs SETUP.md's check queries, including the bucket-size query.
- **The suite was checked by mutation** on 2026-10-18: removing or weakening each rule in a scratch copy of schema.sql
  (the guard trigger, the hourly cap, the guard's window at 1 minute, 30 minutes and 2 hours, `[.]` → `.`, a bare uuid cast,
  the 800 MB cap, the photo count, the hour, the status, nested paths, a table-wide grant, granting paid_at, the updated_at
  trigger, the code, email and phone patterns, the payment_ref index, EXECUTE on the guard, RLS off on orders, the insert
  policy's check loosened to `true` or missing its paid_at or job_ids clause, `set search_path = ''` dropped from one function
  or all three) made the matching test fail every time. The checks added on 2026-10-22 (items, delivery, the 30-photo
  upload regex) haven't been mutation-tested. The `personality` rule was, on 2026-10-23: allowing it on a drawing, empty,
  201 characters, untrimmed or as a list, or refusing the key, each failed the suite. `SUPABASE_STUBS` in test.mjs must stay a plain template literal
  (no `${…}` or backslashes): the Life2Print end-to-end emulator reads it out of this file.
- **`npm run check`** (`scripts/check.mjs`): deploy.yml's three key rules on every file `git add -A` would stage (tracked
  plus untracked-not-ignored, from `git ls-files`; `site/` alone without git), printing file names only and stopping there on
  a hit, since the next checks print source lines. Then `node --check` on app.js and config.js (it shows the line and a
  caret), an import of config.js that must export `CONFIG`, and warnings for a price or Grow link app.js would ignore.
- **What PGlite can't show:** the gateway's key handling and CORS (Supabase answers `Access-Control-Allow-Origin: *`), two
  requests racing (one connection), storage-api's real two-step check (it runs the RLS check again when an upload completes), and
  differences between PGlite's Postgres 18.3 and Supabase's version.
- **End-to-end:** a Supabase emulator on PGlite (the real schema.sql behind a PostgREST/Storage-shaped HTTP server) and a
  headless-Chrome suite of the page live in a session scratchpad, not in this repo (Life2Print's CLAUDE.md, "Testing
  orders", describes them). Rebuild from that description if needed. On 2026-10-22 the page's suite passed 31 scenarios:
  among them 3 figurines with 1/2/3 photos stored as 1–6.jpg in order (checked by sha256), 10 figurines with 30 photos,
  removal and renumbering, per-figurine errors, the totals and the delivery/address rule, the Grow steps with and without
  `growItems`, the pending panel, a pick dropped when its figurine is removed mid-preparation, and every insert refusal.
  It found that the total ignored an unset `pickupPoint` price (fixed) and that upload errors named photos by their
  number in the order rather than per figurine as the thumbnails do (fixed: `photoName`).
- **`scripts/serve.mjs`** serves `site/` under `/life2print-site/` like Pages, so an absolute path breaks locally too; `/` redirects
  there, keeping the query (`/?paid`). Only html, css, js, json, svg, png and jpg are served; it resolves each path and refuses
  anything outside `site/` (`..`, `%2e%2e`, backslashes, drive paths). `Cache-Control: no-cache`.
- **Phones need the published site:** `crypto.randomUUID()` needs a secure context, which localhost is and `http://<LAN IP>` isn't.
- **deploy.yml's shell steps** were tested by extracting them from the parsed YAML and running them under `bash -eo pipefail`
  against fake `site/` folders (made-up keys only): the guard fails on an `sb_secret_` key, a service_role JWT and a comment
  naming either, and passes an anon JWT; the load check fails on a geresh typo, a missing `CONFIG` export and an app.js
  syntax error, and passes the committed files.

## Deploying (`.github/workflows/deploy.yml`)

- On a push to `main` or by hand. Permissions: contents read, pages write, id-token write; concurrency `pages`, never cancelled.
  No setup-node or npm: the runner's preinstalled `node` checks the scripts. The owner sets **Settings → Pages → Source:
  GitHub Actions** once.
- **Key guard**, three rules: `config.js` mentions `sb_secret_` or `service_role`; an `sb_secret_` key anywhere in `site/`;
  a JWT anywhere in `site/` whose decoded payload says `service_role` (in a JWT the word only appears once decoded).
  It prints file names only: the Actions logs of a public repo are public. It runs after the push, so its error messages
  say the key is already public and to rotate it (SETUP step 16).
- **Load check**, after the key guard on purpose (a syntax error prints the source line, and the guard has stopped any
  file holding a key): `node --check site/app.js`, then `node --input-type=module -e` importing `./site/config.js` and
  requiring a `CONFIG` object. package.json's `"type": "module"` makes config.js a module for Node.
- **Cache-busting:** GitHub Pages serves every file with `max-age=600`. index.html links `styles.css?v=__V__` and `app.js?v=__V__`,
  app.js imports `./config.js?v=__V__`, and terms.html links the stylesheet and imports config.js the same way; the workflow runs
  `sed -i "s/__V__/${GITHUB_SHA::8}/g" site/*.html site/*.js`, so one deploy's files load together. Locally `__V__` is just a string.
  A new file that imports another needs the same `?v=__V__`.
- Then `actions/upload-pages-artifact@v3` (path `site`) and `actions/deploy-pages@v4`.
- **All paths are relative:** the site will live at `https://www.figureit.co.il/` (a custom domain on GitHub Pages, SETUP
  step 10), but before the domain is connected it's at `https://<user>.github.io/life2print-site/`, and both must work.

## Grow: what we know (2026-10-18)

- **No prefill:** a Grow payment link can't carry the amount, the payer's details or a reference (none documented, and
  pay.grow.link's own JavaScript reads only the page hash). Prefill exists only through the server API (`createPaymentProcess`,
  `CreatePaymentLink`), which browsers can't call.
- So there's **one fixed page** (עמוד קבוע) for every order, where Grow adds up the total: a required custom field
  **"מספר הזמנה"**, the terms page in its תקנון setting, and an external thank-you page `<site>/?paid` (optional in Grow,
  strongly recommended in SETUP: without it a customer who paid still sees the pending panel's Pay button). The site tells
  the customer what to choose there and the total to check. Grow can't stop a wrong choice, so the operator compares the
  amount paid with the order's total in Life2Print.
- **The owner's page as of 2026-10-23,** read from the page's embedded JSON (`pageData`) in headless Chrome:
  - products "פסלון של חיית מחמד" and "פסלון של ציור ילדים", ₪160 each, quantity 0–10;
  - Grow's shipping field "משלוח" (required): "איסוף עצמי" ₪0, "משלוח" ₪25;
  - its description no longer mentions a coupon (it named **FIGURE10** for more than one figurine earlier that day, until
    the discount was dropped); Grow's own "יש לי קוד קופון!" box is still on the page, and whether FIGURE10 still exists
    in the dashboard is unknown;
  - fields: full name, mobile phone and email (required), address (optional), "מספר הזמנה" (required, text up to 50);
  - VAT 18% included; title "יצירת פסלונים של ציורי ילדים וחיות מחמד"; the banner is the owner's TV appearance ("דאבל על
    הכסף"), not a template leftover; `success_url` empty (no thank-you redirect), and no terms link seen.
- **Matching:** Grow's dashboard searches name, email, phone, transaction number and card digits, not custom fields. Whether
  "מספר הזמנה" shows in the transaction details, the export or the receipt is **unverified**: SETUP.md step 12's ₪1 test should
  answer it; record the answer here. Someone other than the customer paying isn't supported (the owner's decision,
  2026-10-23): the form says nothing about it (a hint under the phone did until then), and the confirmation asks them to
  pay with the same name and phone. Automatic confirmation (below) is the planned way to match every payment.
- **The thank-you redirect** from a dashboard-made page carries nothing documented (the API flow adds `&response=success`).
- **Automating confirmation later:** our server function calls `createPaymentProcess` (userId, pageCode, sum, `successUrl`,
  `notifyUrl`, the code in a `cField`), Grow form-posts the result to `notifyUrl` (not JSON), and we answer 200 and call
  `approveTransaction`. Needs a public HTTPS receiver (e.g. a Supabase Edge Function) and Grow's production review (a live site
  with contact phone, business address and a terms checkbox). Details: Grow's docs at developers.grow.business.

## Lessons from nostalgia-festival.github.io

That sibling site (Vite + supabase-js, a ticket lead form before a Tranzila payment page) shaped this one:
- Its `create table if not exists` never migrated: the `email` column was added inside the statement and existed only if someone
  added it by hand. Hence `alter table … add column if not exists` here.
- An insert-only policy means no read-back (`.insert().select()` is refused), so the browser makes the id.
- Nothing stopped duplicates or spam there (`with check (true)`, no unique key). Here: CHECK constraints mirrored in the client,
  the client's id as primary key (a retry can't duplicate), and the insert guard.
- A fast double click inserted two rows, because `disabled` only applies after a re-render: app.js uses a synchronous flag.
- It saved first and let a failed save through to payment; here a failed save blocks payment (see above).
- Its Hebrew docs went stale against the code; this file says to check.
- For later: WhatsApp drops an `og:image` over about 600 KB (use a ~1200 px JPG), and Google's search favicon ignores `data:` URIs
  and wants a raster file at a multiple of 48 px. This site has neither yet.

## Conventions

- **Brand:** "Figure It", two words (the owner's choice, 2026-10-22): in Fredoka a capital I is a plain bar, so "FigureIt"
  read as "Figurelt". The domain and mailbox stay figureit.co.il.
- **Prices include VAT**, as Israeli customers expect; the owner doesn't want it spelled out beyond the terms' one line.
- **Examples** (`site/examples/`, 2026-10-23): one pet and one drawing, each the source photo and the white print, cropped
  from Life2Print's private `Examples/` (`Pets/Examples/Robin2*`, `Drawings/Examples/AchbarBenad*`) with ffmpeg at 600 px
  wide, JPEG, `-map_metadata -1` so no EXIF or GPS goes public. Generic file names, since source names can carry people's
  names. The section sits below the pending and thank-you panels, which app.js shows on load without scrolling to them.
  Its "להזמנה" link (`.to-order`) jumps to `#order-form` (smooth unless reduced motion), and styles.css hides it while
  the form is hidden.
- **Language:** the UI is Hebrew and right-to-left (`<html lang="he" dir="rtl">`, logical CSS properties, `<bdi>` around codes,
  `dir="ltr"` on phone and email inputs); code comments and docs are English.
- **Code:** plain ES modules, no frameworks or build step; app.js stays one readable module. Comments explain why.
- **DOM:** `textContent` and `createElement` for anything built from user input or config; never `innerHTML` with them.
- **CSS:** tokens on `:root` with a dark theme under `prefers-color-scheme`, an explicit body background, tap targets of at least
  44 px, visible focus rings, `prefers-reduced-motion`.
- **Forms:** `novalidate` with our own Hebrew messages; client checks mirror schema.sql exactly (same patterns, trimmed before
  measuring and sending, phone normalised first: digits only, a leading 972 becomes 0).

## Life2Print's side (`E:\Git\Life2Print`)

- `server/supabase.js` (REST and Storage client with the secret key), `server/orders.js` (sync every 30 s into
  `data/orders/<id>/`, status changes, job links, photo purge) and the **Orders** tab in `public/`. The tab polls every 30 s
  too, so a new order can take about a minute to show. The card shows each figurine with its photos and Make model
  buttons, and each job records which figurine it's for (`orderItem`).
- **Photo retention in the bucket** (rows are deleted by hand): orders.js settles every photo of an order not marked
  deleted (one last download, else 'missing'), then deletes the bucket copies once the order is done or cancelled, when it
  is still 'new' 14 days after it was made (`UNPAID_PURGE_DAYS`), or when the row is gone from Supabase (marked at a full
  sync: hourly, at startup or on Refresh, and confirmed with a single-row lookup). The local copies stay. It can't purge an
  order it never synced, which SETUP step 13 covers. terms.html's privacy text promises this, so keep the two in step.
- Config: `SupabaseAPI.txt` (two lines, the URL and the secret key, either order) or `SUPABASE_URL` + `SUPABASE_SECRET_KEY`
  (the environment wins). The file is picked up without a restart, also after a fix; the env vars only when Life2Print is
  restarted from a shell that has them.
- The server refuses anything that spends credits for an order whose payment isn't confirmed, and answers only on localhost
  (`ALLOW_LAN=1` opens it) because it now serves customers' personal data.

## Open questions and next steps

- **Grow page:** if the coupon FIGURE10 still exists in Grow's dashboard, it should be deleted (the site no longer has a
  price for 2 or more). Its terms link and thank-you page (`success_url`) weren't set on 2026-10-23.
- **Custom domain:** www.figureit.co.il isn't connected yet (SETUP step 10). The mailbox contact@figureit.co.il is on the
  same domain, so its MX records must survive the DNS change.
- **₪1 test:** where does "מספר הזמנה" appear in Grow? Does the thank-you redirect land on the `?paid` note?
- **First real upload:** is the storage fallback policy needed? Does `rolbypassrls` say true for `postgres`?
- **Real phones:** iPhone and Android with 3 full-size camera photos, one taken in portrait (EXIF orientation 6).
- **terms.html** needs the business details and a lawyer's review before real orders.
- **Automatic payment confirmation** (Grow API + a webhook receiver) and **row retention**: Life2Print deletes bucket photos
  (see Life2Print's side), but order rows stay until the owner deletes them by hand (SETUP step 13, "Personal data").
- **og:image** and a PNG favicon.
