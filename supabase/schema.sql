-- Life2Print customer orders: the orders table, the order-photos bucket, and who may do what.
--
-- Run the whole file in the Supabase SQL editor (SETUP.md, step 2). It is re-runnable: running it again keeps
-- the data and resets the functions, triggers, grants, policies and bucket settings to what's written here.
--
-- Who does what:
--   * The customer site (publishable key, role anon) inserts one order row, then uploads that order's photos.
--     It can't read, change or delete anything afterwards, not even the row it just wrote.
--   * Life2Print on the operator's PC (secret key, role service_role, which bypasses RLS) reads orders,
--     downloads and deletes photos, and sets status, paid_at, payment_ref and job_ids.
--
-- Changing the schema later: `create table if not exists` does nothing to a table that already exists, so a column
-- added inside it never reaches the live database (the nostalgia site's email column was added that way, so it existed
-- only if someone also added it by hand). Add columns below the table with
-- `alter table public.orders add column if not exists …`, and change a check with
-- `alter table public.orders drop constraint if exists <name>, add constraint <name> check (…)`.
-- If the browser sends the new column, add it to the anon insert grant as well.
--
-- Regexes are written without backslashes ([.] rather than \.) so they keep their meaning when copied into a
-- JavaScript string; the site's form checks mirror them.

-- ---------- Private schema ----------

-- SECURITY DEFINER functions live here rather than in public: Supabase's API exposes only public, so nobody can call
-- them as POST /rest/v1/rpc/<name>.
create schema if not exists private;
revoke all on schema private from public;
-- The storage upload policy runs as anon and calls private.can_upload_order_photo, so anon needs EXECUTE on it
-- (below). It gets USAGE on the schema too; that exposes nothing, since the API serves only public.
grant usage on schema private to anon;

-- ---------- Orders ----------

create table if not exists public.orders (
  id            uuid not null,                         -- made by the browser (crypto.randomUUID); also the photo folder
  code          text not null,                         -- 6 digits the customer types into Grow's "מספר הזמנה" field
  created_at    timestamptz not null default now(),
  -- The figurines, 1–10: [{"kind": "pet" | "drawing", "subject_name": the pet's or character's name or null,
  -- "personality": a pet's character ("אופי") or null, "photos": 1–3}, …]; rows from before 2026-10-23 have no
  -- "personality". Their photos are numbered on through the order: with [{…, "photos": 2}, {…, "photos": 1}],
  -- 1.jpg and 2.jpg are the first figurine's and 3.jpg the second's. Checked by orders_items_valid (below).
  items         jsonb not null,
  customer_name text not null,
  phone         text not null,
  email         text not null,
  delivery      text not null,                         -- 'pickup' (self-pickup) or 'pickup_point' (sent to one)
  address       text,                                  -- for a pickup point: the customer's address; null for self-pickup
  notes         text,
  photo_count   int not null,                          -- photos are <id>/1.jpg … <id>/<photo_count>.jpg
  price_ils     numeric,                               -- the total the site showed; informational
  user_agent    text,
  status        text not null default 'new',           -- set by the operator from here on
  paid_at       timestamptz,
  payment_ref   text,                                  -- Grow transaction or approval (asmachta) number
  job_ids       text[] not null default '{}',          -- Life2Print jobs made for this order
  updated_at    timestamptz not null default now(),    -- set by the orders_set_updated_at trigger

  -- The site tells these two apart when an insert fails with 23505 (unique_violation), so they're named:
  -- a clash on orders_pkey means an earlier try of the same order was saved; on orders_code_key, pick another code.
  constraint orders_pkey primary key (id),
  constraint orders_code_key unique (code),
  -- No leading 0, so the code survives a numeric field or a spreadsheet export unchanged.
  constraint orders_code_format check (code ~ '^[1-9][0-9]{5}$'),
  -- Names and addresses are stored trimmed, so what the operator searches for is what was typed.
  constraint orders_customer_name_length check (char_length(btrim(customer_name)) between 2 and 120),
  constraint orders_customer_name_trimmed check (customer_name = btrim(customer_name)),
  -- Israeli numbers in local form: 05XXXXXXXX mobile, 0X-XXXXXXX landline. The browser drops spaces and dashes and
  -- turns a leading 972 into 0, so the operator can search Grow's dashboard by the same digits.
  constraint orders_phone_format check (phone ~ '^0[0-9]{8,9}$'),
  constraint orders_email_length check (char_length(email) <= 200),
  -- The excluded characters would let a mailto: link carry extra headers (a@b.co?bcc=…).
  constraint orders_email_format check (
    email ~ '^[^@[:space:]?#&%/,;<>"]+@[^@[:space:]?#&%/,;<>"]+[.][^@[:space:]?#&%/,;<>"]+$'),
  constraint orders_address_length check (char_length(address) between 5 and 500),
  constraint orders_address_trimmed check (address = btrim(address)),
  constraint orders_notes_length check (char_length(notes) <= 2000),
  constraint orders_price_ils_range check (price_ils >= 0 and price_ils < 100000),
  constraint orders_user_agent_length check (char_length(user_agent) <= 500),
  constraint orders_status_check check (status in ('new', 'paid', 'started', 'done', 'cancelled')),
  constraint orders_payment_ref_length check (char_length(payment_ref) <= 100)
  -- The checks on items, photo_count, delivery and address are added below, where an existing table gets them too.
);

-- Whether `items` lists the figurines of an order with `photo_count` photos: 1–10 objects, each with exactly the keys
-- kind ('pet' or 'drawing'), subject_name (null, or 1–80 characters with no space at either end) and photos (1, 2
-- or 3), and optionally personality (null, or for a pet 1–200 characters with no space at either end), whose photos
-- add up to photo_count. personality is optional because it came later (2026-10-23): the rows from before don't
-- have it, and this check runs again on them. Anything malformed is false rather than an error, so a bad row is
-- refused as a check violation naming orders_items_valid, which the site recognises.
--
-- A check constraint runs its function as whoever writes the row, so anon (inserting) and service_role (updating:
-- every check runs again on every update) need EXECUTE. It reads nothing but its arguments.
create or replace function private.order_items_valid(items jsonb, photo_count int)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  total int := 0;
begin
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 10 then
    return false;
  end if;
  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item) is distinct from 'object'
       or item - 'kind' - 'subject_name' - 'photos' - 'personality' <> '{}'::jsonb
       or not (item ? 'subject_name')
       or coalesce(item ->> 'kind', '') not in ('pet', 'drawing')
       or jsonb_typeof(item -> 'photos') is distinct from 'number'
       or coalesce(item ->> 'photos', '') not in ('1', '2', '3') then
      return false;
    end if;
    if jsonb_typeof(item -> 'subject_name') = 'string' then
      if char_length(item ->> 'subject_name') not between 1 and 80
         or item ->> 'subject_name' <> btrim(item ->> 'subject_name') then
        return false;
      end if;
    elsif jsonb_typeof(item -> 'subject_name') <> 'null' then
      return false;
    end if;
    -- Without the key, jsonb_typeof gives null and neither branch applies.
    if jsonb_typeof(item -> 'personality') = 'string' then
      if item ->> 'kind' <> 'pet'
         or char_length(item ->> 'personality') not between 1 and 200
         or item ->> 'personality' <> btrim(item ->> 'personality') then
        return false;
      end if;
    elsif jsonb_typeof(item -> 'personality') <> 'null' then
      return false;
    end if;
    total := total + (item ->> 'photos')::int;
  end loop;
  return total = photo_count;
end;
$$;

revoke execute on function private.order_items_valid(jsonb, int) from public, authenticated;
grant execute on function private.order_items_valid(jsonb, int) to anon, service_role;

-- 2026-10-22: an order holds 1–10 figurines (items) instead of one (kind, subject_name), and the customer chooses
-- self-pickup or delivery to a pickup point. This brings a table made by the first version of this file to the shape
-- above, moving each order's figurine into items; on a table made by this version it changes nothing.
alter table public.orders add column if not exists items jsonb, add column if not exists delivery text;
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'orders' and column_name = 'kind') then
    update public.orders
      set items = jsonb_build_array(jsonb_build_object(
                    'kind', kind, 'subject_name', nullif(btrim(subject_name), ''), 'photos', photo_count)),
          delivery = 'pickup_point'
      where items is null;
    alter table public.orders drop column kind, drop column subject_name;
  end if;
end;
$$;
alter table public.orders
  alter column items set not null,
  alter column delivery set not null,
  alter column address drop not null;

-- Checks added or changed since the first version: dropped and added again, so every run leaves exactly these.
alter table public.orders
  drop constraint if exists orders_items_valid,
  add constraint orders_items_valid check (private.order_items_valid(items, photo_count)),
  -- Up to 10 figurines of up to 3 photos each.
  drop constraint if exists orders_photo_count_range,
  add constraint orders_photo_count_range check (photo_count between 1 and 30),
  drop constraint if exists orders_delivery_check,
  add constraint orders_delivery_check check (delivery in ('pickup', 'pickup_point')),
  -- An address exactly when the order is sent to a pickup point. (Another delivery is orders_delivery_check's to refuse.)
  drop constraint if exists orders_address_delivery,
  add constraint orders_address_delivery check (case delivery when 'pickup' then address is null
                                                              when 'pickup_point' then address is not null
                                                              else true end);

-- Later column changes go here, as `alter table public.orders add column if not exists …` (see the top of the file).

-- One Grow payment can't be recorded against two orders.
create unique index if not exists orders_payment_ref_key on public.orders (payment_ref) where payment_ref is not null;
-- Life2Print polls for rows changed since its last sync.
create index if not exists orders_updated_at_idx on public.orders (updated_at);

-- Life2Print syncs by updated_at, so it must move on every change, whoever makes it (the operator's PC, or a hand edit
-- in the Table Editor), and by the database's clock rather than the PC's. Clients never send it.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger orders_set_updated_at
  before update on public.orders
  for each row
  execute function private.set_updated_at();

-- The insert guard: one order per request, and a cap on orders per hour, so a script holding the public key can't
-- fill the free plan's 500 MB (or the Orders tab) with rows. A free project that goes over its limits turns read-only
-- or refuses every request, and then no real customer can order.
--
-- Why a statement trigger rather than a policy: PostgREST inserts a JSON array as one statement, and a policy is
-- checked per row by functions that see the table as it was before the statement, so a 1,000-row insert passes a
-- "fewer than N orders" policy. This AFTER … FOR EACH STATEMENT trigger runs once the rows are in, sees them in
-- new_rows and in the table, and raising rolls the whole statement back.
--
-- SECURITY DEFINER because anon can't read public.orders to count them. The message is what the site looks for
-- (with SQLSTATE P0001) to say "too many orders right now, try again in a few minutes".
create or replace function private.orders_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Orders accepted per hour from everyone together. Real orders come a few a day, so this only stops floods;
  -- raise it if a genuinely busy hour ever hits it.
  max_orders_per_hour constant int := 20;
begin
  if (select count(*) from new_rows) > 1 then
    raise exception 'orders_rate_limit' using detail = 'One order per request.';
  end if;
  if (select count(*) from public.orders where created_at > now() - interval '1 hour') > max_orders_per_hour then
    raise exception 'orders_rate_limit'
      using detail = format('More than %s orders in the last hour.', max_orders_per_hour);
  end if;
  return null;
end;
$$;

create or replace trigger orders_insert_guard
  after insert on public.orders
  referencing new table as new_rows
  for each statement
  execute function private.orders_insert_guard();

-- Trigger functions can't be called directly, and Postgres doesn't check EXECUTE when a trigger fires (test.mjs checks
-- both), so nobody needs it. Revoking keeps Supabase's Security Advisor quiet.
revoke execute on function private.set_updated_at() from public, anon, authenticated;
revoke execute on function private.orders_insert_guard() from public, anon, authenticated;

-- Access. RLS is on, and anon has no SELECT, UPDATE or DELETE grant and no policy for them.
--
-- Why column grants: a policy accepts or rejects whole rows; it can't stop a client from choosing a column's value.
-- A column-level INSERT grant can. anon may name only these columns, so status, paid_at, payment_ref, job_ids,
-- created_at and updated_at always take their defaults; naming any of them, even as null, fails with 42501.
-- (Revoke the table-level grant first: a column revoke under a table grant restricts nothing.)
--
-- Why no select: the site never reads a row back. The browser makes the id and the code itself and inserts with
-- Prefer: return=minimal, which PostgREST runs as `insert … returning 1`, needing no SELECT. So anon can't list other
-- customers' orders, and an upsert (on conflict …, which needs SELECT or UPDATE) fails: a retry can't overwrite a row.
--
-- Supabase projects created since 2026-05-30 (and all projects from 2026-10-30) get no automatic grants in public,
-- so service_role's are spelled out too; without them even the secret key gets 42501.
alter table public.orders enable row level security;
revoke all on table public.orders from public, anon, authenticated;
grant insert (id, code, items, customer_name, phone, email, delivery, address, notes, photo_count, price_ils,
              user_agent)
  on table public.orders to anon;
grant select, insert, update, delete on table public.orders to service_role;

-- RLS needs a policy to let anon insert at all. Its check repeats what the grants already ensure, in case a column
-- is ever granted by mistake.
drop policy if exists orders_anon_insert on public.orders;
create policy orders_anon_insert on public.orders
  for insert to anon
  with check (status = 'new' and paid_at is null and payment_ref is null and job_ids = '{}');

-- ---------- Photos ----------

-- Private: photos are read only by Life2Print with the secret key. 4 MB per file, up to 30 files per order: the site
-- sends JPEGs of at most 2048 px, re-encoded until under 3.5 MB (usually 0.5–2 MB). JPEG only: the site converts every
-- photo, HEIC included.
-- Storage takes the type from the upload's Content-Type header, not the bytes; Life2Print checks the bytes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-photos', 'order-photos', false, 4194304, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- May anon upload a file at this path? Only <order id>/<n>.jpg, for an order that is still 'new' and less than an
-- hour old, with 1 <= n <= its photo_count, while the bucket holds under 800 MB. The hour bounds what a script can
-- upload per order; after it, the site starts a fresh order from the photos it still holds.
--
-- Written so that no input raises an error (a bad path must be refused, not crash the upload): the folder is cast to
-- uuid only once it looks like one, and substring() gives null for any other file name, which compares as not true.
--
-- The 800 MB cap (the free plan has 1 GB) sums the bucket as this function's owner, postgres. On Supabase postgres
-- has BYPASSRLS; without it, RLS on storage.objects would hide every row, the sum would be 0, and the cap would
-- silently never trigger while uploads still worked. SETUP.md has the query to check.
--
-- anon needs EXECUTE: the storage upload policy calls this; don't revoke it even if Supabase's Security Advisor
-- suggests it. Being in private, it can't be called through the API.
create or replace function private.can_upload_order_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    array_length(storage.foldername(object_name), 1) = 1
    and exists (
      select 1
      from public.orders o
      where o.id = case
                     when (storage.foldername(object_name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then ((storage.foldername(object_name))[1])::uuid
                   end
        and o.status = 'new'
        and o.created_at > now() - interval '1 hour'
        and substring(storage.filename(object_name) from '^([1-9][0-9]?)[.]jpg$')::int <= o.photo_count
    )
    and (select coalesce(sum((s.metadata ->> 'size')::bigint), 0)
         from storage.objects s
         where s.bucket_id = 'order-photos') < 800 * 1024 * 1024;
$$;

revoke execute on function private.can_upload_order_photo(text) from public, authenticated;
grant execute on function private.can_upload_order_photo(text) to anon;

-- Uploading needs only an INSERT policy. With no select, update or delete policy, anon can't list, download, overwrite
-- or delete photos; Storage refuses a second upload to the same path (the site sends x-upsert: false).
-- If real uploads fail with "new row violates row-level security policy", see "Storage fallback policy" in SETUP.md.
drop policy if exists order_photos_anon_insert on storage.objects;
create policy order_photos_anon_insert on storage.objects
  for insert to anon
  with check (bucket_id = 'order-photos' and private.can_upload_order_photo(name));
