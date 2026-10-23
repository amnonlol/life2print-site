# Setting up customer orders

This guide takes the order page from this repo to taking real orders. You'll set up five things:

1. a **Supabase** project (free plan) that stores the orders and their photos;
2. a **Grow** payment page;
3. the **site** on GitHub Pages;
4. the **domain** www.figureit.co.il, pointed at the site;
5. **Life2Print** on your PC, which reads the orders with Supabase's secret key.

Allow about an hour, plus a real ₪1 test payment at the end. Dashboard menu names are as of October 2026 and may move.

How an order works, in one line: the customer adds 1–10 figurines (each with 1–3 photos), chooses self-pickup or delivery
to a pickup point, and submits; the page saves the order and uploads the photos, shows a 6-digit order number and the
total, and sends them to your Grow page, saying which items to choose there. The customer types the order number into
Grow's "מספר הזמנה" field. Within about a minute the order shows in Life2Print's **Orders** tab; you check the payment in
Grow, click **Payment received**, and make the models.

## 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com/dashboard) and click **New project**.
2. Name it (e.g. `life2print`), and pick the region **Central EU (Frankfurt)**: closest to Israel among the EU regions,
   and the terms page says the data is stored in the EU.
3. Generate a database password and keep it in your password manager. Neither the site nor Life2Print needs it.
4. Leave the **Data API** on, serving the `public` schema (the default). The site and Life2Print talk to it.
5. If the form offers **Enable automatic RLS**, tick it. It isn't required, because `schema.sql` turns RLS on for its own
   table, but it protects any table added to `public` later by turning RLS on as it's created.
6. Create the project and wait until it's ready (a minute or two).

## 2. Create the tables and rules

1. Open **SQL Editor**, click **New query**, and paste the whole of [`supabase/schema.sql`](supabase/schema.sql).
2. Click **Run**. If Supabase warns about destructive operations, that's the file dropping and re-creating its own
   policies; confirm. It should end with "Success. No rows returned".

This creates the `orders` table, the private `order-photos` bucket, and the rules: the site can add an order and upload
that order's photos for one hour, and nothing else (it can't read, change or delete anything). The file can be run again
at any time; it keeps the data. The comments in it explain each rule.

**Ran an earlier version of the file?** (before 2026-10-22, when an order held a single figurine.) Run the whole of the
current file again in the same way. It upgrades the table in place: each existing order becomes a one-figurine order
sent to a pickup point. Do it before you publish the new site, which sends orders in the new shape and fails against the
old table.

## 3. Check the result

Run these in the SQL editor, one at a time:

```sql
select rolbypassrls from pg_roles where rolname = 'postgres';
```

It must say **true**. The upload rule stops uploads once the bucket holds 800 MB (the free plan has 1 GB), and it measures
the bucket as the `postgres` role. Without this right, `postgres` would see an empty bucket, and the cap would never
trigger: uploads would keep working until the plan's limit was hit. If it says false, the site still works, but check
the bucket's size now and then with the query under "Uploads stopped: bucket full" in step 13, and ask Supabase support
about it.

```sql
select private.can_upload_order_photo('00000000-0000-0000-0000-000000000000/1.jpg');
```

It must say **false**, with no error. An error such as "permission denied for table objects" means every customer upload
would fail: don't go live until it's fixed.

```sql
select grantee, privilege_type, column_name from information_schema.column_privileges
where table_schema = 'public' and table_name = 'orders' and grantee = 'anon' order by column_name;
```

Expect 12 rows, all `INSERT`: `address`, `code`, `customer_name`, `delivery`, `email`, `id`, `items`, `notes`, `phone`,
`photo_count`, `price_ils`, `user_agent`. Any `SELECT` row means customers could read each other's orders: run
`schema.sql` again, which resets the grants.

## 4. Lock down what the site doesn't use

- **Authentication → Sign In / Providers:** turn off **Allow new users to sign up**. Anyone holding the site's public key
  could otherwise create an account. The schema gives signed-in users nothing anyway; this closes the door as well.
- **Realtime → Settings:** turn off **Allow public access**. The site doesn't use Realtime, and public channels are open to
  anyone with the public key and count against your quotas. Supabase then warns "No Realtime RLS policies found … No messages
  will be received by users". That's the intended result: nothing here uses Realtime, so save anyway and don't add policies.

## 5. Usage warnings

Supabase sends its warnings by email: a project nearing or over a free-plan limit, or paused for inactivity.
Make sure your Supabase account's email address is one you read, and look at **Organization → Usage** now and then.
Step 13 has the limits.

## 6. The two keys

Open **Project Settings → API Keys**. There are two kinds of key; they go to different places.

| Key | Looks like | Goes in | Who sees it |
|---|---|---|---|
| Project URL (**Project Settings → Data API**, or the **Connect** button) | `https://abcdefghijklmnop.supabase.co` | `site/config.js` and Life2Print's `SupabaseAPI.txt` | everyone |
| **Publishable key** | `sb_publishable_…` | `site/config.js` only | everyone: it's public by design, and the database rules do the protecting |
| **Secret key** (under **Secret keys**, click **Add new secret key**, name it e.g. `life2print-pc`) | `sb_secret_…` | Life2Print's `SupabaseAPI.txt` only | only your PC |

The secret key bypasses every rule: whoever has it can read every customer's name, phone, address and photos.
**Never put it in this repo.** The site refuses to open orders with one in `config.js`, and the deploy fails if one is
anywhere in `site/`, but only after the push, when it's already public. So run `npm run check` before every commit
(step 9), and if the deploy ever fails on a key, rotate it (step 16).

Projects made before November 2025 also have legacy `anon` and `service_role` keys (long strings starting with `eyJ`).
They work too (`anon` in place of the publishable key, `service_role` in place of the secret key), but Supabase is
retiring them; prefer the new ones.

## 7. The Grow payment page

Grow can't take the order number, the amount or the customer's details from a link, so there's one fixed page that every
customer pays on. They choose the products, quantities, shipping and coupon the site tells them, Grow adds up the total,
and they type the order number in. In Grow's dashboard, under payment links, create (or edit) a **fixed page** (עמוד
קבוע) with (this is how the page was set up on 2026-10-23):

- **A product per kind of figurine**, each ₪160 with a quantity choice (0–10): "פסלון בודד של חיית מחמד" and "פסלון
  בודד של ציור ילדים".
- **Shipping** (Grow's "משלוח" field, required): "איסוף עצמי" at ₪0 and "משלוח" at ₪25, the site's self-pickup and
  delivery to a pickup point.
- **A coupon for 2 or more figurines** ("FIGURE10"). It must bring Grow's total to the site's: `prices.each` per
  figurine (₪150), so ₪10 off each figurine.
- **The names go in `site/config.js`** (step 8), exactly as Grow shows them, so the confirmation can say "choose
  "פסלון בודד של חיית מחמד", quantity 2, and "פסלון בודד של ציור ילדים", quantity 1; in "משלוח" choose "משלוח"; enter
  the coupon FIGURE10". Grow can't stop a wrong choice, so the site also shows the total to check, and you compare the
  amount paid with the order's total in Life2Print. The prices shown include VAT.
- **No open amount** (סכום פתוח off).
- **A required custom field** (שדה מיוחד) labelled exactly **מספר הזמנה**. Make it a number field if Grow offers one:
  order numbers are 6 digits and never start with 0.
- Keep Grow's payer fields: full name, phone and email. You'll match payments by them.
- **Terms (תקנון):** link `https://www.figureit.co.il/terms.html`, with the required checkbox.
- **Thank-you page (strongly recommended):** choose an external page and enter `https://www.figureit.co.il/?paid`.
  After paying, the customer lands on a thank-you note on the site that repeats their order number. It's also the only
  way the site learns that the customer paid. Without it, a customer who paid and comes back to the site within 24 hours
  still sees a panel with their last order number and a Pay button. The panel says not to pay twice and has a
  "כבר שילמתי / הסתרה" button, but some will pay again, and you'd refund them. Grow passes nothing back, so the note
  confirms nothing; you still confirm each payment in Life2Print. (Until the domain works, step 10, use the github.io
  address instead: `https://<your GitHub user>.github.io/life2print-site/?paid` and `…/terms.html`.)
- **Webhook / server notifications:** leave empty for now (see step 18).

Copy the page's link (`https://pay.grow.link/…`) for the next step.

## 8. Fill in `site/config.js` and the terms

`site/config.js` holds the site's public settings. Orders stay closed ("ההזמנות ייפתחו בקרוב") until the project URL, the
publishable key and a contact phone or email are set; the browser console says what's missing.

```js
export const CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabasePublishableKey: 'sb_publishable_…',
  contact: { phone: '', email: 'contact@figureit.co.il' },           // at least one
  business: { name: '…', id: 'ע״מ …', address: '…' },                // shown on the terms page and in the footer
  deliveryDays: '10',                                                // business days until it's sent or ready for pickup
  pickupFrom: 'גבעתיים',                                             // where self-pickup is
  prices: { one: 160, each: 150, pickupPoint: 25 },                  // see below
  growUrl: 'https://pay.grow.link/…',
  growItems: { pet: 'פסלון בודד של חיית מחמד', drawing: 'פסלון בודד של ציור ילדים' },
  growShipping: { pickup: 'איסוף עצמי', pickup_point: 'משלוח' },
  growCoupon: 'FIGURE10',
};
```

- **Prices** are what the page shows and adds up: `one` for an order of one figurine, `each` per figurine in an order of
  2 or more, `pickupPoint` for delivery. Grow's page sets what's charged, so keep them equal to its products, shipping
  and coupon. Write a plain number without quotes (`160`, not `'160'`); `null` hides it, and the totals that need it.
- **`growUrl`** is the whole link as Grow shows it, starting with `https://`. **Without it**, the confirmation tells the
  customer you'll be in touch about payment instead of showing a pay button.
- **`growItems`**, **`growShipping`** and **`growCoupon`** are the Grow page's product per kind of figurine, its two
  shipping options and the coupon for 2 or more, exactly as Grow shows them. The confirmation turns them into steps
  (which products and how many, which shipping option, the coupon). A name left `''` leaves its step out; the total to
  check and the order number are always there.
- **A price or link in another form is ignored as if it weren't set**: a link pasted without `https://` gives no Pay
  button, and a price in quotes isn't shown. The browser console warns about it, and so does `npm run check` (step 9).
- **Hebrew abbreviations break the file.** Every value sits inside `'…'`, so an ASCII apostrophe or double quote in
  Hebrew text ends the string early: `address: 'רח' הרצל 5'` makes the whole of `config.js` unreadable. Use the Hebrew
  geresh ׳ and gershayim ״ instead (`'רח׳ הרצל 5, ת״א'`), or wrap the value in backticks (`` `רח' הרצל 5` ``).
  A `config.js` that doesn't load leaves the page closed ("ההזמנות ייפתחו בקרוב", the form greyed out) and without
  your contact details.

Then open `site/terms.html`. It is a template, not legal advice. The comment at its top lists what to do:

1. fill every `[placeholder]` in square brackets (the business details, phone, email and delivery time come from
   `config.js` once they're set there);
2. check every statement against how you actually work (prices, VAT, shipping, how long you keep data);
3. remove the dashed notes marked "לבדיקה";
4. **have a lawyer review the page** before taking real orders: cancelling custom-made goods, product safety for a
   child's toy, and the privacy notice.

## 9. Check it, and try it locally

After every change to `config.js`, and before every commit, run the checks (no `npm install` needed):

```sh
npm run check
```

It must end with "All checks passed". It fails if any file a commit would include holds a secret key, or if `config.js`
mentions `sb_secret_` or `service_role` at all, even in a comment. It also fails if `config.js` or `app.js` doesn't
load, and then shows the line. It warns about a price or Grow link the page would ignore (step 8). The deploy runs the
key and loading checks too, but only after the push (step 10).

To try the page itself (optional):

```sh
npm install
npm start          # http://localhost:8080/life2print-site/
```

With the real `config.js` this places **real orders** in your Supabase project. Place one with two figurines and a photo
or two each, and check: **Table Editor → orders** has the row (its `items` lists both figurines), and **Storage →
order-photos** has a folder named after its id with `1.jpg`… numbered on through the order. Mark it cancelled later in
Life2Print (step 11).

A phone on your Wi-Fi can't use this preview: the page needs a secure address (https, or localhost on the same machine)
to make order ids. Test phones on the published site (step 12).

## 10. Publish on GitHub Pages

1. On GitHub, create a **new public repository** named `life2print-site`. Leave the README, .gitignore and licence
   options off: any of them gives the GitHub repo a first commit of its own, and the push below is then refused.
   It must be public: Pages from a private repo needs a paid plan, which is why the site isn't part of Life2Print's repo.
2. This folder has no commits yet. Check it, stage everything, look at what will be published (the repository is
   public), then commit and push:
   ```sh
   npm run check
   git add -A
   git status
   git commit -m "Life2Print order page"
   git remote add origin https://github.com/<your GitHub user>/life2print-site.git
   git push -u origin main
   ```
   `npm run check` must end with "All checks passed". `git status` should list only `.gitignore`, `CLAUDE.md`,
   `README.md`, `SETUP.md`, `package.json`, `package-lock.json` and files under `.github/`, `scripts/`, `site/` and
   `supabase/`. If it lists anything else, remove it from the folder (or add it to `.gitignore`), and run `git add -A`
   again before committing.
3. In the repository, open **Settings → Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**.
4. Open the **Actions** tab. The **Deploy to GitHub Pages** run publishes the site at
   `https://<your GitHub user>.github.io/life2print-site/` (if the first run started before step 3, click **Re-run all jobs**).

5. **Connect the domain.** In **Settings → Pages → Custom domain**, enter `www.figureit.co.il` and save. Then, where the
   domain's DNS is managed (your registrar or DNS host), add:
   - a `CNAME` record for `www` pointing to `<your GitHub user>.github.io`;
   - for the bare `figureit.co.il`, four `A` records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and
     `185.199.111.153`, so it forwards to www.

   **Leave the `MX` records alone**: they deliver the mail for contact@figureit.co.il. Back in **Settings → Pages**, wait
   until the DNS check passes (minutes to a few hours), then tick **Enforce HTTPS**. Recommended: verify the domain in
   your GitHub account (**Settings → Pages → Add a domain**, a TXT record), so nobody else's repository can claim it.
   The workflow deploys with GitHub Actions, so no `CNAME` file is needed in the repository.
   Until the domain works, the site is at `https://<your GitHub user>.github.io/life2print-site/`; afterwards that address
   forwards to www.figureit.co.il.

Every push to `main` publishes again within a minute or two. The run fails, and the live site stays as it was, if
`site/` contains a secret key, if `config.js` mentions `sb_secret_` or `service_role` at all (even in a comment), or if
`app.js` or `config.js` doesn't load (the run's log shows the line). **The key check runs after the push, on a public
repository: if it fails because of a key, that key is already public in this repository's history. Rotate it at once
(step 16); removing it in a new commit doesn't undo the leak.** That's why `npm run check` comes before every commit:
it runs the same checks while the key is still only on your PC.

Browsers keep each file for up to 10 minutes, so a visitor may see the previous version briefly after a deploy.
The deploy stamps the file links with the commit, so the page's files always load as a matching set.

## 11. Connect Life2Print

1. In the Life2Print folder (`E:\Git\Life2Print`), create `SupabaseAPI.txt` with two lines, in either order:
   ```
   https://abcdefghijklmnop.supabase.co
   sb_secret_…
   ```
   The file is git-ignored, and Life2Print picks it up without a restart, also after you correct a mistake in it.
   Alternatively, set the environment variables `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, which override the file.
   They take effect only when Life2Print is started from a terminal that already has them (open a new terminal after
   `setx`); the automatic restarts of `npm run dev` keep the old environment.
2. Open Life2Print (http://localhost:3000) and the **Orders** tab. Within about a minute it lists the orders: the server
   syncs every 30 seconds, and the tab asks for the result every 30 seconds (**Refresh**, once it's enabled, syncs at
   once). If it says Supabase isn't set up, the server's console output says why, e.g. a publishable key in the file
   instead of the secret one, or an `http://` URL.

Life2Print now holds customers' personal details, so it answers only on this PC (`localhost`). Set `ALLOW_LAN=1` only if
you deliberately want it reachable from your network, and only on a network you trust.

### Handling an order

- A new order shows as **Awaiting payment**, with its total, its figurines (each with its photos, downloaded to
  `data\orders\<id>\`) and how it's delivered: self-pickup, or a pickup point near the customer's address.
- **Find the payment in Grow** (Transactions): search by the customer's phone, name or email, and look for the order
  number in "מספר הזמנה". Someone else may have paid for them, so the order number is the surest match. **Check the
  amount** against the order's total: Grow can't stop a customer choosing the wrong items.
- Click **Payment received**, optionally type Grow's transaction or approval number, and **Confirm**. A recorded
  number can't be used for a second order, which catches one payment being matched twice.
- Click **Make model** under a figurine's photo. It opens the Pets or Drawings form with that photo and the name filled
  in, and a banner saying which order (and which figurine) it's for. Crop and choose settings as usual, then **Generate**.
  The order becomes **In progress**, and the job is listed under its figurine. A figurine still without a model is marked
  on the card. Life2Print refuses to spend credits on an order whose payment isn't confirmed.
- When it ships, or has been picked up, click **Mark done**. At the next sync Life2Print deletes the order's photos from Supabase (the copies on
  your PC stay), which keeps the bucket small, and the card says "Photos removed from Supabase".
- **Cancel** abandoned or refunded orders, so their photos are deleted from Supabase too. **Reopen** brings one back;
  the photos on your PC are still there for **Make model**.
- "Upload not finished (k of N photos)" means the customer's photos didn't all arrive. An order accepts photos for one
  hour. If the customer's page was left for longer than that mid-upload (a phone put away, say) and they then tried
  again, it placed a fresh order with a new number from the same details and photos, so look for an order with the same
  phone or email (the card says "Same phone as …" or "Same email as …"). Otherwise their page showed an error with your contact
  details, and a retry goes on uploading into this same order. If they don't come back, contact them. Once you've found
  the newer order, or given up on this one, **Cancel** it.
- Several orders with "Upload not finished (0 of N photos)" within a short time mean uploads are being refused for
  everyone: see "Uploads stopped: bucket full" in step 13, then step 14.

## 12. End-to-end check, with a real ₪1 payment

Do this once before announcing the site, and again after changing the Grow pages.

1. In Grow, set the "פסלון בודד של חיית מחמד" product's price to **₪1** for the test.
2. On the published site, on your phone, place an order of one pet figurine with 3 photos straight from the camera and
   self-pickup, and pay with a real card on the Grow page, choosing what the confirmation names and typing the order
   number into "מספר הזמנה".
3. Write down **where the order number shows up in Grow**, and add what you find to `CLAUDE.md` (under Grow):
   - the transaction's details in the dashboard;
   - the transactions export (Excel);
   - the receipt the payer gets by SMS or email;
   - Grow's notification email to you.

   Nobody has checked this yet. If it shows nowhere you can see it, match payments by phone, name and email, and
   consider the automatic confirmation in step 18.
4. Check you land on the site's thank-you note with your order number (the thank-you page from step 7). Then press
   **Back** until you're on the order page again: it must not offer the pay button for this order.
5. In Life2Print, the order shows up with its 3 photos, upright. Click **Payment received** with the transaction number.
6. Refund the ₪1 from the transaction in Grow's dashboard, set the price back, and **Cancel** the test order in Life2Print.
7. Place a second order (no need to pay; **Cancel** it afterwards) with **three figurines**, pets and drawings, and
   **delivery to a pickup point**. Check that the total is 3 × 150 + 25 = ₪475, that the confirmation names both products
   with their quantities, the shipping option "משלוח" and the coupon, and that doing exactly that on the Grow page (stop
   before paying) gives the same total. In Life2Print the card shows the three figurines with the right photos under
   each, and the address.

Then test on real phones: an **iPhone** (Safari) and an **Android** phone (Chrome). On each, order with **3 full-size camera
photos, at least one taken in portrait**, and check in Life2Print that each photo arrived upright and complete. Once,
also order **10 figurines with 3 photos each** on a phone, to see that 30 photos prepare and upload without the page
running out of memory (keep the page open: they upload one at a time). Also try:

- going to Grow and pressing **Back** without paying: the page shows "ההזמנה האחרונה שלכם: …" with the pay button, and
  the same after closing and reopening the tab; "כבר שילמתי / הסתרה" hides it, and it stays hidden after a reload;
- turning on airplane mode during the photo upload: the page offers to try again, and finishes once you're back online.

**Cancel** these test orders in Life2Print afterwards, so their photos are deleted from Supabase.

## 13. Running it: free-plan limits

| Free plan | Limit | What uses it |
|---|---|---|
| Database | 500 MB | Orders: about 1 KB each, so this is very far off |
| File storage | 1 GB (uploads stop at 800 MB) | Photos: about 0.5–2 MB each, up to 30 per order, deleted by Life2Print once an order is done or cancelled, or 14 days after an unpaid one |
| Egress | 5 GB a month | Life2Print's sync (only changed rows) and each photo's single download |
| File size | 50 MB | The bucket allows 4 MB per photo; the site sends under 3.5 MB |

- **Pausing:** Supabase pauses a free project after **7 days** with little database activity. Life2Print's sync, every
  30 seconds while it's running, keeps it awake. If your PC will be off for more than about 5 days, run any query in
  the SQL editor now and then (e.g. `select count(*) from orders;`). While paused, the site can't save orders:
  customers see an error with your contact details. To restore, open the project in the dashboard and click
  **Restore project**; it takes a few minutes and keeps the data. Do it promptly: a project left paused too long may no
  longer be restorable from the dashboard.
- **Order cap:** the database accepts at most **20 orders an hour** from everyone together, and one per request, which
  stops a script from flooding it. Customers over the cap are asked to try again in a few minutes. To change it, edit
  `max_orders_per_hour` in `supabase/schema.sql` and run the file again.
- **Upload window:** an order accepts its photos for one hour after it's placed, and only while it's awaiting payment.
- **Personal data:** customers' details stay in the `orders` table until you delete the rows; nothing deletes rows
  automatically. Photos are deleted from **Storage → order-photos** by Life2Print, at the next sync after an order is
  **Done** or **Cancelled**, and 14 days after an order that was never paid. Before that it downloads any photo it
  doesn't have yet, so its own copies in `data\orders\<id>\` are complete; those stay until you delete them by hand.
  The order's card then says "Photos removed from Supabase". To delete old orders, as your terms promise:
  1. In Life2Print, **Cancel** (or **Mark done**) each order you're about to delete, and wait until its card says
     "Photos removed from Supabase" (the next sync; **Refresh** syncs at once).
  2. Then delete the rows in the **Table Editor**. At its next full sync (hourly, at startup or on **Refresh**)
     Life2Print marks those orders "Deleted in Supabase".

  If a row goes first, Life2Print still deletes its photos at that full sync, once a direct lookup confirms the row is
  gone. But it can't for an order it never saw: a row deleted while Life2Print wasn't running, before it synced that
  order. Delete that order's folder (named after its `id`) in **Storage → order-photos** yourself. Use the dashboard
  for this: Supabase refuses a SQL `delete from storage.objects`.
- **Uploads stopped: bucket full.** The upload rule refuses every photo once the bucket holds 800 MB. Customers then
  get an error saying a photo couldn't be uploaded, with your contact details; the browser console names a full bucket
  as one likely cause; and Life2Print fills with orders showing "Upload not finished (0 of N photos)". Check the size in
  the SQL editor:
  ```sql
  select pg_size_pretty(sum((metadata->>'size')::bigint)) from storage.objects where bucket_id = 'order-photos';
  ```
  With Life2Print running, the bucket holds only the photos of orders that are paid or in progress, or unpaid and under
  14 days old, so a full bucket means a flood of junk orders or Life2Print being off for a long time. To free space,
  **Cancel** the junk or abandoned orders in Life2Print (their photos go at the next sync), or delete their folders in
  **Storage → order-photos**. After a flood, consider lowering `max_orders_per_hour` in `supabase/schema.sql` and
  running it again.

## 14. Storage fallback policy

`schema.sql` lets the site upload photos with an INSERT rule only, as Supabase's Storage docs say is enough. One of
Supabase's troubleshooting pages says otherwise: that Storage reads the new file's row back during an upload, which
would also need a SELECT rule. Nobody has tried a real upload yet.

**If** the first real upload fails while the order row was saved, with "new row violates row-level security policy"
(the browser console points here too, and the order shows in Life2Print as "Upload not finished (0 of N photos)"),
first make sure the bucket isn't full (the query in step 13). If it isn't, run this in the SQL editor:

```sql
create policy order_photos_select_during_upload on storage.objects for select to anon
using (bucket_id = 'order-photos' and storage.allow_only_operation('object.upload'));
```

It lets the site read file rows only while Storage is handling an upload; listing and downloading are other operations,
so they stay closed. Then add the same statement at the end of `supabase/schema.sql` (preceded by
`drop policy if exists order_photos_select_during_upload on storage.objects;`, so the file stays re-runnable), and note
in `CLAUDE.md` that it was needed.

## 15. Changing the schema later

`schema.sql` creates the table with `create table if not exists`, which does nothing to a table that already exists.
So **don't** add a column by editing that statement: it would never reach the live database. Instead, add a line below it,
then run the whole file again:

```sql
alter table public.orders add column if not exists gift_wrap boolean not null default false;
```

To change a check, drop and re-add it under the same name (the site recognises fields by these names):

```sql
alter table public.orders drop constraint if exists orders_notes_length,
  add constraint orders_notes_length check (char_length(notes) <= 4000);
```

If the site will send the new column, also add it to the `grant insert (…) on table public.orders to anon` list in
`schema.sql`, and to the site's form and checks. Then run `npm test` before running the file in Supabase.

## 16. If a key leaks

- **Secret key** (`sb_secret_…`): in **Project Settings → API Keys**, create a new secret key, put it in `SupabaseAPI.txt`,
  then delete the leaked one. Anyone who had it could read everything, so treat customers' data as exposed.
  This includes a key that was only ever pushed to GitHub, even if the deploy failed on it and a later commit removed
  it: the repository's history is public. GitHub's secret scanning may also report a pushed key to Supabase, which can
  revoke it on its own; if Life2Print suddenly can't sync after such a push, that's why.
- **Publishable key:** nothing to do; it's public by design.
- A legacy `service_role` key is replaced only together with the `anon` one, by rotating the project's JWT secret.
  It's simpler to switch to the new keys and disable the legacy ones (**Project Settings → API Keys**).

## 17. Checklist before announcing the site

- [ ] `rolbypassrls` is true, and the upload check returns false without an error (step 3)
- [ ] Sign-ups and Realtime public access are off (step 4)
- [ ] `site/config.js` has the URL, the publishable key, contact details, prices, the Grow link and the Grow page's
      product, shipping and coupon names, and `npm run check` passes with no warnings (step 9)
- [ ] `terms.html` is filled in and reviewed, and the Grow page links it
- [ ] The Grow page: a product per kind at the config's price, the two shipping options, the coupon giving the config's
      price for 2 or more, required "מספר הזמנה", thank-you page `https://www.figureit.co.il/?paid`
- [ ] www.figureit.co.il opens the site over https, and mail to contact@figureit.co.il still arrives (step 10)
- [ ] The ₪1 test passed and was refunded, and you know where Grow shows the order number
- [ ] A three-figurine order with delivery showed the right items and total, on the site and on Grow (step 12)
- [ ] iPhone and Android orders arrived with upright photos
- [ ] Life2Print's Orders tab shows orders, and `SupabaseAPI.txt` isn't in any repo

## 18. Later: automatic payment confirmation

Today you confirm each payment by hand. Grow's API could do it: a small server function (e.g. a Supabase Edge Function)
would create a Grow payment per order with the order number attached, and receive Grow's notification when it's paid,
then mark the order paid. It needs Grow API credentials and Grow's review of the integration. Out of scope for now.
