// Tests supabase/schema.sql in PGlite (Postgres compiled to WebAssembly): no network, no Supabase project.
// Run: npm test
//
// PGlite has no gateway, PostgREST or Storage API, so this file stubs what schema.sql relies on (Supabase's API roles
// and a minimal storage schema) and replays the SQL those services send:
//   * PostgREST's insert for Prefer: return=minimal, `insert … select … from json_to_recordset(<body>) returning 1`,
//     run as anon inside a transaction;
//   * storage-api's upload check, a plain insert into storage.objects as anon.
// What it can't show: the gateway's key handling and CORS, two requests racing (PGlite has a single connection), and
// differences between Postgres 18 here and the version Supabase runs.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');

// ---------- Supabase stubs ----------

// The API roles: the publishable key acts as anon, the secret key as service_role, which bypasses RLS.
// foldername and filename are storage-api's own definitions; allow_only_operation is a stand-in that reads the
// operation storage-api sets for each request ('storage.object.upload' for an upload).
// Life2Print's end-to-end Supabase emulator reads this literal out of the file, so keep it plain SQL in one template
// literal, with no ${…} and no backslashes.
const SUPABASE_STUBS = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  grant usage on schema public to anon, authenticated, service_role;

  create schema storage;
  grant usage on schema storage to anon, authenticated, service_role;
  create table storage.buckets (
    id text primary key,
    name text not null unique,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz default now()
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamptz default now(),
    unique (bucket_id, name)
  );
  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;
  -- Supabase grants these to the API roles, so RLS policies alone decide.
  grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

  create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
  declare _parts text[];
  begin
    select string_to_array(name, '/') into _parts;
    return _parts[1 : array_length(_parts, 1) - 1];
  end $$;
  create function storage.filename(name text) returns text language plpgsql immutable as $$
  declare _parts text[];
  begin
    select string_to_array(name, '/') into _parts;
    return _parts[array_length(_parts, 1)];
  end $$;
  create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$
    select coalesce(current_setting('storage.operation', true) in (expected_operation, 'storage.' || expected_operation),
                    false)
  $$;
`;

// The columns the site sends: exactly the ones anon may insert.
const SITE_COLUMNS = ['id', 'code', 'items', 'customer_name', 'phone', 'email', 'delivery', 'address', 'notes',
  'photo_count', 'price_ils', 'user_agent'];

// Column types, as PostgREST reads them from the schema to build its insert.
const COLUMN_TYPES = {
  id: 'uuid', code: 'text', items: 'jsonb', customer_name: 'text', phone: 'text', email: 'text', delivery: 'text',
  address: 'text', notes: 'text', photo_count: 'int', price_ils: 'numeric', user_agent: 'text',
  status: 'text', paid_at: 'timestamptz', payment_ref: 'text', job_ids: 'text[]', created_at: 'timestamptz',
  updated_at: 'timestamptz',
};

const MB = 1024 * 1024;
const db = new PGlite();

// ---------- Requests ----------

// One API request: a transaction with the role and JWT claims set locally, as PostgREST and storage-api do.
// An error rolls it back.
function request(role, fn, settings = {}) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    for (const [name, value] of Object.entries(settings)) {
      await tx.query('select set_config($1, $2, true)', [name, value]);
    }
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

// POST /rest/v1/orders as PostgREST builds it: the JSON body (an object or an array) becomes rows through
// json_to_recordset, the columns are the body's keys, and Prefer: return=minimal gives `returning 1`.
// `resolution` is Prefer: resolution=merge-duplicates | ignore-duplicates, PostgREST's upsert.
function restInsert(body, { role = 'anon', resolution } = {}) {
  const rows = Array.isArray(body) ? body : [body];
  const columns = Object.keys(rows[0]);
  const names = columns.map((c) => `"${c}"`).join(', ');
  const types = columns.map((c) => `"${c}" ${COLUMN_TYPES[c]}`).join(', ');
  const onConflict = {
    'merge-duplicates': `on conflict ("id") do update set ${columns.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`,
    'ignore-duplicates': 'on conflict ("id") do nothing',
  }[resolution] ?? '';
  return request(role, (tx) => tx.query(`
    with pgrst_source as (
      insert into public.orders (${names})
      select ${names} from json_to_recordset($1::json) as pgrst_body (${types})
      ${onConflict}
      returning 1
    )
    select count(*)::int as inserted from pgrst_source`, [JSON.stringify(rows)]));
}

// POST /storage/v1/object/<bucket>/<path>: storage-api checks the upload with a plain insert (no RETURNING) as the
// caller. Here that insert is also the stored row; storage-api records the file's size in metadata.
function upload(path, { bucket = 'order-photos', size = 400_000 } = {}) {
  return request('anon', (tx) => tx.query(
    'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3::jsonb)',
    [bucket, path, JSON.stringify({ size, mimetype: 'image/jpeg' })],
  ), { 'storage.operation': 'storage.object.upload' });
}

// PGlite's own user is a superuser, like the dashboard's SQL editor: it sets up what RLS would refuse.
const admin = (sql, params) => db.query(sql, params);
const countOrders = async () => (await admin('select count(*)::int as n from public.orders')).rows[0].n;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastCode = 100000;
const nextCode = () => String(++lastCode);

// One figurine of an order, as the site sends it.
const figurine = (fields = {}) => ({ kind: 'pet', subject_name: 'רובין', photos: 1, ...fields });

// An order as the site sends it: only the columns anon may insert, values trimmed and normalised.
function newOrder(fields = {}) {
  return {
    id: crypto.randomUUID(),
    code: nextCode(),
    items: [figurine()],
    customer_name: 'דנה כהן',
    phone: '0501234567',
    email: 'dana@example.co.il',
    delivery: 'pickup_point',
    address: 'הרצל 1, תל אביב',
    notes: null,
    photo_count: 1,
    price_ils: 185,
    user_agent: 'Mozilla/5.0 (test)',
    ...fields,
  };
}

// Expects a refusal with this SQLSTATE and, if given, this text in the message. PostgREST passes both on to the
// browser, and the site reads constraint names out of the message.
async function refused(label, promise, code, text) {
  let error;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  assert.ok(error, `${label}: was accepted`);
  assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} "${error.message}"`);
  if (text) assert.ok(error.message.includes(text), `${label}: expected "${text}" in "${error.message}"`);
}

// ---------- Runner ----------

let passed = 0;
const failed = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${String(error.message).replaceAll('\n', '\n        ')}`);
  }
}

const section = (title) => console.log(`\n${title}`);

// ---------- Schema ----------

section('Schema');

await test('schema.sql runs on a fresh database', async () => {
  await db.exec(SUPABASE_STUBS);
  await db.exec(SCHEMA);
});

await test('schema.sql runs a second time', () => db.exec(SCHEMA));

if (failed.length) {
  console.log('\nschema.sql did not load; nothing else can be tested.');
  process.exit(1);
}

await test('anon may insert exactly the columns the site sends, and nothing else', async () => {
  const columns = await admin(`
    select column_name, privilege_type from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'orders' and grantee = 'anon'
    order by column_name`);
  assert.deepEqual(columns.rows, [...SITE_COLUMNS].sort().map((c) => ({ column_name: c, privilege_type: 'INSERT' })));
  const tables = await admin(`
    select grantee, privilege_type from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'orders' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
  assert.deepEqual(tables.rows, []);
});

await test('the bucket is private, 4 MB per file, JPEG only', async () => {
  const { rows } = await admin(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'order-photos'`);
  assert.equal(rows[0].public, false);
  assert.equal(Number(rows[0].file_size_limit), 4 * MB);
  assert.deepEqual(rows[0].allowed_mime_types, ['image/jpeg']);
});

await test('anon keeps EXECUTE on can_upload_order_photo and order_items_valid; nothing else can be run', async () => {
  const { rows } = await admin(`select
    has_function_privilege('anon', 'private.can_upload_order_photo(text)', 'execute') as anon_upload,
    has_function_privilege('authenticated', 'private.can_upload_order_photo(text)', 'execute') as authenticated_upload,
    has_function_privilege('anon', 'private.order_items_valid(jsonb, int)', 'execute') as anon_items,
    has_function_privilege('service_role', 'private.order_items_valid(jsonb, int)', 'execute') as service_items,
    has_function_privilege('authenticated', 'private.order_items_valid(jsonb, int)', 'execute') as authenticated_items,
    has_function_privilege('anon', 'private.orders_insert_guard()', 'execute') as anon_guard,
    has_function_privilege('anon', 'private.set_updated_at()', 'execute') as anon_updated_at`);
  assert.deepEqual(rows[0], {
    anon_upload: true, authenticated_upload: false, anon_items: true, service_items: true, authenticated_items: false,
    anon_guard: false, anon_updated_at: false,
  });
  await refused('calling a trigger function', admin('select private.orders_insert_guard()'), '0A000');
});

// A SECURITY DEFINER function without a fixed search_path resolves unqualified names through the caller's path,
// the classic way to hijack one. The list is complete, so a new function in private fails here until it's added.
await test('the private functions fix search_path, and only the two that need it are SECURITY DEFINER', async () => {
  const { rows } = await admin(`
    select proname, prosecdef, proconfig from pg_proc
    where pronamespace = 'private'::regnamespace order by proname`);
  assert.deepEqual(rows, [
    { proname: 'can_upload_order_photo', prosecdef: true, proconfig: ['search_path=""'] },
    { proname: 'order_items_valid', prosecdef: false, proconfig: ['search_path=""'] },
    { proname: 'orders_insert_guard', prosecdef: true, proconfig: ['search_path=""'] },
    { proname: 'set_updated_at', prosecdef: false, proconfig: ['search_path=""'] },
  ]);
  // any definer function elsewhere (one added to public later, say) must fix its search_path too
  const { rows: unpinned } = await admin(`
    select p.oid::regprocedure::text as fn from pg_proc p
    where p.prosecdef and p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
      and not coalesce(p.proconfig @> array['search_path=""'], false)`);
  assert.deepEqual(unpinned, []);
});

await test("SETUP.md's check queries run", async () => {
  const bypass = await admin(`select rolbypassrls from pg_roles where rolname = 'postgres'`);
  assert.equal(bypass.rows[0].rolbypassrls, true);
  const probe = await admin(`select private.can_upload_order_photo('00000000-0000-0000-0000-000000000000/1.jpg') as ok`);
  assert.equal(probe.rows[0].ok, false);
  // step 13, "Uploads stopped: bucket full" (null while the bucket is empty)
  const size = await admin(`
    select pg_size_pretty(sum((metadata->>'size')::bigint)) as used from storage.objects where bucket_id = 'order-photos'`);
  assert.equal(size.rows.length, 1);
});

// ---------- Orders, as the site (anon) ----------

section('Orders, as anon');

const first = newOrder();

await test('a valid order is saved, with status and the operator fields at their defaults', async () => {
  const { rows } = await restInsert(first);
  assert.equal(rows[0].inserted, 1);
  const saved = (await admin('select * from public.orders where id = $1', [first.id])).rows[0];
  assert.equal(saved.status, 'new');
  assert.equal(saved.paid_at, null);
  assert.equal(saved.payment_ref, null);
  assert.deepEqual(saved.job_ids, []);
  assert.ok(saved.created_at instanceof Date && saved.updated_at instanceof Date);
});

await test('values at the limits are accepted', async () => {
  await restInsert(newOrder({
    items: Array.from({ length: 10 }, (_, i) => figurine({
      kind: i % 2 ? 'drawing' : 'pet', subject_name: 'ש'.repeat(80), photos: 3,
    })),
    customer_name: 'דן',
    phone: '031234567',
    email: `dana+order@${'x'.repeat(180)}.co.il`,
    address: 'א'.repeat(500),
    notes: 'ה'.repeat(2000),
    photo_count: 30,
    price_ils: 0,
    user_agent: 'u'.repeat(500),
  }));
  await restInsert(newOrder({
    items: [figurine({ subject_name: null }), figurine({ kind: 'drawing', subject_name: 'ד', photos: 2 })],
    photo_count: 3,
    customer_name: 'כ'.repeat(120),
    address: 'רחוב1',
    price_ils: 99999.99,
  }));
});

await test('self-pickup takes no address', () => restInsert(newOrder({ delivery: 'pickup', address: null, price_ils: 160 })));

await test('anon can’t set a protected column, even to its default', async () => {
  const now = new Date().toISOString();
  const values = { status: 'new', paid_at: null, payment_ref: null, job_ids: [], created_at: now, updated_at: now };
  for (const [column, value] of Object.entries(values)) {
    await refused(column, restInsert(newOrder({ [column]: value })), '42501', 'permission denied');
  }
});

// Everything above is refused by the column grants. RLS and the orders_anon_insert policy are the second layer, so
// they need their own test: without it, turning RLS off or loosening the check to `true` would pass unnoticed.
await test('RLS on orders is the backstop: a column granted by mistake still can’t take an operator value', async () => {
  const { rows } = await admin(`select relrowsecurity from pg_class where oid = 'public.orders'::regclass`);
  assert.equal(rows[0].relrowsecurity, true, 'RLS is off on public.orders');
  // one value per clause of orders_anon_insert's check, so loosening any one clause fails
  const operatorValues = { status: 'paid', paid_at: new Date().toISOString(), payment_ref: 'GROW-X', job_ids: ['job-1'] };
  for (const [column, value] of Object.entries(operatorValues)) {
    const order = newOrder({ [column]: value });
    const names = Object.keys(order).map((c) => `"${c}"`).join(', ');
    const types = Object.keys(order).map((c) => `"${c}" ${COLUMN_TYPES[c]}`).join(', ');
    // the mistaken grant and the request share one transaction that never commits, so neither outlives the test
    await refused(column, db.transaction(async (tx) => {
      await tx.exec(`grant insert (${column}) on public.orders to anon; set local role anon;`);
      await tx.query(`insert into public.orders (${names})
        select ${names} from json_to_recordset($1::json) as pgrst_body (${types}) returning 1`, [JSON.stringify([order])]);
      await tx.rollback();
    }), '42501', 'row-level security');
  }
  // a stray select grant shows anon nothing, since there's no select policy
  const seen = await db.transaction(async (tx) => {
    await tx.exec('grant select on public.orders to anon; set local role anon;');
    const r = await tx.query('select id from public.orders');
    await tx.rollback();
    return r.rows.length;
  });
  assert.equal(seen, 0, 'a stray select grant exposed orders');
  const left = await admin(`select has_column_privilege('anon', 'public.orders', 'status', 'insert') as anon_status,
    has_table_privilege('anon', 'public.orders', 'select') as anon_select`);
  assert.deepEqual(left.rows[0], { anon_status: false, anon_select: false }, 'the test left a grant behind');
});

await test('anon can’t read, change or delete orders', async () => {
  await refused('select *', request('anon', (tx) => tx.query('select * from public.orders')), '42501');
  await refused('select id', request('anon', (tx) => tx.query('select id from public.orders')), '42501');
  await refused('update', request('anon', (tx) => tx.query(`update public.orders set notes = 'x'`)), '42501');
  await refused('delete', request('anon', (tx) => tx.query('delete from public.orders')), '42501');
});

await test('anon can’t upsert over an existing order', async () => {
  const changed = { ...first, notes: 'overwritten' };
  await refused('merge-duplicates', restInsert(changed, { resolution: 'merge-duplicates' }), '42501');
  await refused('ignore-duplicates', restInsert(changed, { resolution: 'ignore-duplicates' }), '42501');
  const { rows } = await admin('select notes from public.orders where id = $1', [first.id]);
  assert.equal(rows[0].notes, null);
});

await test('a signed-in user (authenticated) can’t insert', () =>
  refused('authenticated', restInsert(newOrder(), { role: 'authenticated' }), '42501'));

const BAD_VALUES = [
  ['code', '012345', 'orders_code_format'],
  ['code', '12345', 'orders_code_format'],
  ['code', '1234567', 'orders_code_format'],
  ['code', 'AB1234', 'orders_code_format'],
  ['customer_name', 'ד', 'orders_customer_name_length'],
  ['customer_name', 'x'.repeat(121), 'orders_customer_name_length'],
  ['customer_name', ' דנה כהן', 'orders_customer_name_trimmed'],
  ['customer_name', 'דנה כהן ', 'orders_customer_name_trimmed'],
  ['phone', '+972501234567', 'orders_phone_format'],
  ['phone', '972501234567', 'orders_phone_format'],
  ['phone', '050-1234567', 'orders_phone_format'],
  ['phone', '501234567', 'orders_phone_format'],
  ['phone', '05012345', 'orders_phone_format'],
  ['phone', '05012345678', 'orders_phone_format'],
  ['email', 'a@b.co?bcc=x', 'orders_email_format'],
  ['email', 'a@b.co&body=x', 'orders_email_format'],
  ['email', 'dana@example', 'orders_email_format'],
  ['email', 'dana cohen@example.com', 'orders_email_format'],
  ['email', '<dana@example.com>', 'orders_email_format'],
  ['email', 'dana@@example.com', 'orders_email_format'],
  ['email', `${'x'.repeat(195)}@b.com`, 'orders_email_length'],
  ['address', 'רחוב', 'orders_address_length'],
  ['address', 'x'.repeat(501), 'orders_address_length'],
  ['address', 'הרצל 1, תל אביב ', 'orders_address_trimmed'],
  ['notes', 'x'.repeat(2001), 'orders_notes_length'],
  ['delivery', 'mail', 'orders_delivery_check'],
  ['address', null, 'orders_address_delivery'],
  ['price_ils', -1, 'orders_price_ils_range'],
  ['price_ils', 100000, 'orders_price_ils_range'],
  ['user_agent', 'x'.repeat(501), 'orders_user_agent_length'],
];

await test(`bad values are refused, naming the constraint (${BAD_VALUES.length} cases)`, async () => {
  for (const [column, value, constraint] of BAD_VALUES) {
    const label = `${column} = ${JSON.stringify(value).slice(0, 40)}`;
    await refused(label, restInsert(newOrder({ [column]: value })), '23514', constraint);
  }
});

// Every malformed list of figurines is refused as orders_items_valid, never with another error. The figurines'
// photos must add up to photo_count (1 in newOrder).
const BAD_ITEMS = [
  ['an object', { kind: 'pet', subject_name: null, photos: 1 }],
  ['a string', 'pet'],
  ['empty', []],
  ['11 figurines', Array.from({ length: 11 }, () => figurine())],
  ['a figurine that is a string', ['pet']],
  ['a figurine that is null', [null]],
  ['an unknown kind', [figurine({ kind: 'cat' })]],
  ['no kind', [{ subject_name: null, photos: 1 }]],
  ['no subject_name key', [{ kind: 'pet', photos: 1 }]],
  ['an extra key', [figurine({ size: 'big' })]],
  ['0 photos', [figurine({ photos: 0 })]],
  ['4 photos', [figurine({ photos: 4 })]],
  ['photos as text', [figurine({ photos: '1' })]],
  ['photos as a fraction', [figurine({ photos: 1.5 })]],
  ['an empty name', [figurine({ subject_name: '' })]],
  ['an untrimmed name', [figurine({ subject_name: ' רובין' })]],
  ['an 81-character name', [figurine({ subject_name: 'x'.repeat(81) })]],
  ['a name that is a number', [figurine({ subject_name: 5 })]],
  ['more photos than photo_count', [figurine(), figurine()]],
  ['fewer photos than photo_count', [figurine({ photos: 2 })], { photo_count: 3 }],
];

await test(`bad lists of figurines are refused as orders_items_valid (${BAD_ITEMS.length} cases)`, async () => {
  for (const [label, items, fields = {}] of BAD_ITEMS) {
    await refused(label, restInsert(newOrder({ items, ...fields })), '23514', 'orders_items_valid');
  }
  await refused('photo_count 0', restInsert(newOrder({ photo_count: 0 })), '23514', 'orders_items_valid');
});

await test('an address with self-pickup is refused (orders_address_delivery)', () =>
  refused('pickup with an address', restInsert(newOrder({ delivery: 'pickup' })), '23514', 'orders_address_delivery'));

await test('the same id again is 23505 on orders_pkey, even with a new code', () =>
  refused('same id', restInsert({ ...first, code: nextCode() }), '23505', 'orders_pkey'));

await test('an exact retry of a saved order is 23505 on orders_pkey, not orders_code_key', () =>
  refused('exact retry', restInsert(first), '23505', 'orders_pkey'));

await test('the same code on another order is 23505 on orders_code_key', () =>
  refused('same code', restInsert(newOrder({ code: first.code })), '23505', 'orders_code_key'));

await test('a request with 2 orders is refused whole (P0001 orders_rate_limit)', async () => {
  const before = await countOrders();
  await refused('2 rows', restInsert([newOrder(), newOrder()]), 'P0001', 'orders_rate_limit');
  assert.equal(await countOrders(), before);
});

// ---------- Photos, as the site (anon) ----------

section('Photos, as anon');

const twoPhotos = newOrder({ items: [figurine({ photos: 2 })], photo_count: 2 });

await test('an order of 2 photos takes <id>/1.jpg and <id>/2.jpg', async () => {
  await restInsert(twoPhotos);
  await upload(`${twoPhotos.id}/1.jpg`);
  await upload(`${twoPhotos.id}/2.jpg`);
});

await test('an order of 30 photos takes <id>/30.jpg, and nothing past it', async () => {
  const order = newOrder({ items: Array.from({ length: 10 }, () => figurine({ photos: 3 })), photo_count: 30 });
  await restInsert(order);
  await upload(`${order.id}/10.jpg`);
  await upload(`${order.id}/30.jpg`);
  for (const file of ['31.jpg', '100.jpg', '010.jpg', '00.jpg']) {
    await refused(file, upload(`${order.id}/${file}`), '42501', 'row-level security');
  }
});

await test('any other file name in the order’s folder is refused', async () => {
  for (const file of ['3.jpg', '4.jpg', '0.jpg', '1xjpg', '1.jpgx', '1.png', '1.JPG', '01.jpg', 'evil.html']) {
    await refused(file, upload(`${twoPhotos.id}/${file}`), '42501', 'row-level security');
  }
});

await test('a folder that isn’t a uuid is refused without an error', async () => {
  await refused('not-a-uuid', upload('not-a-uuid/1.jpg'), '42501', 'row-level security');
  await refused('upper-case uuid', upload(`${twoPhotos.id.toUpperCase()}/1.jpg`), '42501');
});

await test('nested paths and the bucket root are refused', async () => {
  await refused('nested', upload(`${twoPhotos.id}/x/1.jpg`), '42501');
  await refused('under a folder', upload(`x/${twoPhotos.id}/1.jpg`), '42501');
  await refused('root', upload('1.jpg'), '42501');
});

await test('a folder with no order behind it is refused', () =>
  refused('unknown id', upload(`${crypto.randomUUID()}/1.jpg`), '42501'));

await test('uploads close an hour after the order was made', async () => {
  const late = newOrder();
  await restInsert(late);
  await admin(`update public.orders set created_at = now() - interval '61 minutes' where id = $1`, [late.id]);
  await refused('after 61 minutes', upload(`${late.id}/1.jpg`), '42501');
  await admin(`update public.orders set created_at = now() - interval '59 minutes' where id = $1`, [late.id]);
  await upload(`${late.id}/1.jpg`);
});

await test('uploads close once the order isn’t new', async () => {
  const order = newOrder();
  await restInsert(order);
  for (const status of ['paid', 'started', 'done', 'cancelled']) {
    await admin('update public.orders set status = $2 where id = $1', [order.id, status]);
    await refused(status, upload(`${order.id}/1.jpg`), '42501');
  }
});

await test('another bucket is refused', async () => {
  await admin(`insert into storage.buckets (id, name) values ('other', 'other')`);
  const order = newOrder();
  await restInsert(order);
  await refused('other bucket', upload(`${order.id}/1.jpg`, { bucket: 'other' }), '42501');
});

await test('uploads stop once the bucket holds 800 MB', async () => {
  const order = newOrder();
  await restInsert(order);
  const used = (await admin(`
    select coalesce(sum((metadata ->> 'size')::bigint), 0)::bigint as used
    from storage.objects where bucket_id = 'order-photos'`)).rows[0].used;
  // a stand-in for everything else in the bucket, bringing it to exactly 800 MB
  await admin(`insert into storage.objects (bucket_id, name, metadata) values ('order-photos', 'filler/1.jpg', $1::jsonb)`,
    [JSON.stringify({ size: 800 * MB - Number(used) })]);
  await refused('at 800 MB', upload(`${order.id}/1.jpg`), '42501');
  await admin(`update storage.objects set metadata = jsonb_build_object('size', (metadata ->> 'size')::bigint - 1)
               where name = 'filler/1.jpg'`);
  await upload(`${order.id}/1.jpg`);
  await admin(`delete from storage.objects where name = 'filler/1.jpg'`);
});

await test('anon can’t list, download, overwrite or delete photos', async () => {
  const listed = await request('anon', (tx) => tx.query('select name from storage.objects'));
  assert.equal(listed.rows.length, 0, 'select returned rows');
  const deleted = await request('anon', (tx) => tx.query('delete from storage.objects'));
  assert.equal(deleted.affectedRows, 0, 'delete removed rows');
  const updated = await request('anon', (tx) => tx.query(`update storage.objects set metadata = '{}'`));
  assert.equal(updated.affectedRows, 0, 'update changed rows');
  await refused('upsert', request('anon', (tx) => tx.query(`
    insert into storage.objects (bucket_id, name, metadata) values ('order-photos', $1, '{}')
    on conflict (bucket_id, name) do update set metadata = excluded.metadata`, [`${twoPhotos.id}/1.jpg`])), '42501');
  const { rows } = await admin(`select count(*)::int as n from storage.objects where name like $1`, [`${twoPhotos.id}/%`]);
  assert.equal(rows[0].n, 2);
});

await test('the fallback select policy in SETUP.md opens nothing outside an upload', async () => {
  await db.transaction(async (tx) => {
    await tx.exec(`
      create policy order_photos_select_during_upload on storage.objects for select to anon
      using (bucket_id = 'order-photos' and storage.allow_only_operation('object.upload'));
      set local role anon;`);
    const outside = await tx.query('select name from storage.objects');
    await tx.query(`select set_config('storage.operation', 'storage.object.upload', true)`);
    const during = await tx.query('select name from storage.objects');
    await tx.rollback();
    assert.equal(outside.rows.length, 0);
    assert.ok(during.rows.length > 0);
  });
  const { rows } = await admin(`select count(*)::int as n from pg_policies where policyname = 'order_photos_select_during_upload'`);
  assert.equal(rows[0].n, 0, 'the policy outlived the test');
});

// ---------- Insert guard ----------

section('Insert guard');

await test('the 21st order within an hour is refused (P0001 orders_rate_limit)', async () => {
  await admin('delete from public.orders');
  for (let i = 1; i <= 20; i++) await restInsert(newOrder());
  await refused('21st order', restInsert(newOrder()), 'P0001', 'orders_rate_limit');
  assert.equal(await countOrders(), 20);
  // Pinned from both sides, like the upload hour: an order 59 minutes old still counts, one 61 minutes old doesn't.
  // (All 20 were made within a second, so the first refusal alone would pass with a 1-minute window too.)
  const { rows: [oldest] } = await admin('select id from public.orders order by created_at limit 1');
  await admin(`update public.orders set created_at = now() - interval '59 minutes' where id = $1`, [oldest.id]);
  await refused('21st order, oldest at 59 minutes', restInsert(newOrder()), 'P0001', 'orders_rate_limit');
  await admin(`update public.orders set created_at = now() - interval '61 minutes' where id = $1`, [oldest.id]);
  await restInsert(newOrder());
});

// ---------- Operator (service_role) ----------

section('Operator, as service_role');

await test('service_role reads every order', async () => {
  const { rows } = await request('service_role', (tx) => tx.query('select * from public.orders'));
  assert.equal(rows.length, await countOrders());
});

await test('service_role updates the operator fields, and updated_at moves', async () => {
  const { rows: [order] } = await admin('select id, updated_at from public.orders order by created_at limit 1');
  await delay(5);
  const { rows } = await request('service_role', (tx) => tx.query(`
    update public.orders set status = 'paid', paid_at = now(), payment_ref = 'GROW-1', job_ids = array['job-1']
    where id = $1 and status = 'new' returning *`, [order.id]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'paid');
  assert.deepEqual(rows[0].job_ids, ['job-1']);
  assert.ok(rows[0].updated_at > order.updated_at, 'updated_at did not move');
});

await test('updated_at comes from the database: a value sent with an update is replaced', async () => {
  const { rows } = await request('service_role', (tx) => tx.query(`
    update public.orders set notes = 'checked', updated_at = '2000-01-01' where payment_ref = 'GROW-1' returning updated_at`));
  assert.ok(rows[0].updated_at.getFullYear() > 2000);
});

await test('one payment reference can’t go on two orders (23505 orders_payment_ref_key)', async () => {
  const { rows: [other] } = await admin(`select id from public.orders where payment_ref is null limit 1`);
  await refused('second order', request('service_role', (tx) => tx.query(
    `update public.orders set payment_ref = 'GROW-1' where id = $1`, [other.id])), '23505', 'orders_payment_ref_key');
});

// ---------- Running it again ----------

section('Running schema.sql again');

await test('a third run keeps the orders and resets grants and bucket settings', async () => {
  const before = await countOrders();
  // mistakes someone might make by hand in the dashboard
  await admin('grant select on public.orders to anon');
  await admin(`update storage.buckets set public = true, file_size_limit = null where id = 'order-photos'`);
  await db.exec(SCHEMA);
  assert.equal(await countOrders(), before);
  const { rows } = await admin(`select has_table_privilege('anon', 'public.orders', 'select') as anon_select,
    (select row(public, file_size_limit)::text from storage.buckets where id = 'order-photos') as bucket`);
  assert.deepEqual(rows[0], { anon_select: false, bucket: `(f,${4 * MB})` });
});

// ---------- Upgrading a first-version table ----------

section('Upgrading a table made by the first version');

// The first version's orders table (one figurine per order, always sent), as far as the upgrade touches it.
const V1_TABLE = `
  create table public.orders (
    id uuid primary key, code text not null unique, created_at timestamptz not null default now(),
    kind text not null, subject_name text, customer_name text not null, phone text not null, email text not null,
    address text not null, notes text, photo_count int not null, price_ils numeric, user_agent text,
    status text not null default 'new', paid_at timestamptz, payment_ref text, job_ids text[] not null default '{}',
    updated_at timestamptz not null default now(),
    constraint orders_kind_check check (kind in ('pet', 'drawing')),
    constraint orders_subject_name_length check (char_length(subject_name) <= 80),
    constraint orders_photo_count_range check (photo_count between 1 and 3)
  );
  grant insert (id, code, kind, subject_name, customer_name, phone, email, address, notes, photo_count, price_ils,
                user_agent) on table public.orders to anon;`;

await test('schema.sql moves each order’s figurine into items, sent to a pickup point, and keeps the row', async () => {
  const old = new PGlite();
  try {
    await old.exec(SUPABASE_STUBS);
    await old.exec(V1_TABLE);
    const row = [crypto.randomUUID(), crypto.randomUUID()];
    await old.query(`insert into public.orders (id, code, kind, subject_name, customer_name, phone, email, address,
      photo_count, price_ils) values
      ($1, '654321', 'drawing', ' דובי ', 'דנה כהן', '0501234567', 'dana@example.co.il', 'הרצל 1, תל אביב', 2, 150),
      ($2, '654322', 'pet', null, 'דנה כהן', '0501234567', 'dana@example.co.il', 'הרצל 1, תל אביב', 3, 160)`, row);
    await old.exec(SCHEMA);
    await old.exec(SCHEMA); // and once more, as an upgraded table
    const { rows } = await old.query('select id, items, delivery, address, photo_count from public.orders order by code');
    assert.deepEqual(rows, [
      { id: row[0], items: [{ kind: 'drawing', subject_name: 'דובי', photos: 2 }], delivery: 'pickup_point',
        address: 'הרצל 1, תל אביב', photo_count: 2 },
      { id: row[1], items: [{ kind: 'pet', subject_name: null, photos: 3 }], delivery: 'pickup_point',
        address: 'הרצל 1, תל אביב', photo_count: 3 },
    ]);
    const gone = await old.query(`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'orders' and column_name in ('kind', 'subject_name')`);
    assert.deepEqual(gone.rows, []);
    const granted = await old.query(`select column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'orders' and grantee = 'anon' order by column_name`);
    assert.deepEqual(granted.rows.map((r) => r.column_name), [...SITE_COLUMNS].sort());
    // The new checks hold on the upgraded table: self-pickup without an address, and 10 figurines.
    await old.transaction(async (tx) => {
      await tx.exec('set local role anon');
      await tx.query(`insert into public.orders (id, code, items, customer_name, phone, email, delivery, photo_count)
        values ($1, '654323', $2::jsonb, 'דנה כהן', '0501234567', 'dana@example.co.il', 'pickup', 30)`,
      [crypto.randomUUID(), JSON.stringify(Array.from({ length: 10 }, () => figurine({ photos: 3 })))]);
    });
  } finally {
    await old.close();
  }
});

// ---------- Summary ----------

await db.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
