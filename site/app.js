// Figure It order page: the form, photo prep, saving the order to Supabase, and the hand-off to Grow.
// (Figure It is what customers see; Life2Print is the operator's app on the PC that reads these orders.)
//
// Plain fetch, no supabase-js: the page makes one insert and a few uploads, and a 100 KB library from a CDN
// would be one more thing to fail on a phone. Every request sends the publishable key twice, as `apikey` and
// as `Authorization: Bearer` with the identical value (allowed for the new keys, required for legacy JWT keys).
//
// An order holds 1–10 figurines, each with its own kind, name and 1–3 photos. It's saved as one row whose `items`
// lists them in order, and the photos are numbered on through the order (supabase/schema.sql).
//
// The row goes first, then the photos: the browser can't read the table back, and the bucket only takes
// photos into the folder of an order created in the last hour (supabase/schema.sql). Unlike a lead form
// that lets the visitor pay anyway, a failed save blocks payment here: without photos there's nothing to
// make. So every error state offers a way forward instead, a retry and the contact details.
import { CONFIG } from './config.js?v=__V__';

const MAX_FIGURINES = 10;
const MAX_PHOTOS = 3; // per figurine
const MAX_SIDE = 2048; // longest side sent: plenty for a model, and quick to upload from a phone
// Thumbnails are drawn at 96 px. Showing the 2048 px photos instead would keep up to 30 full decodes in memory.
const THUMB_SIDE = 192;
const JPEG_QUALITIES = [0.9, 0.8, 0.7]; // the next one is tried while a photo is over REENCODE_BYTES
const REENCODE_BYTES = 3.5 * 1024 * 1024;
const MAX_BYTES = 4 * 1024 * 1024; // the bucket's file_size_limit
const INSERT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000; // a 2 MB photo on a slow mobile upload takes about a minute
const CODE_TRIES = 3;
const PENDING_SHOWN_MS = 24 * 60 * 60 * 1000;
const PAID_CODE_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'figureit-order';
// Grow's optional thank-you redirect lands on `?paid`. It carries no data, so it confirms nothing.
// Matched loosely because Grow may append its own parameters (`?paid?response=success`).
const PAID_RETURN = /[?&]paid(?=$|[=&?])/;

// The same rules as the checks in supabase/schema.sql, so the database never refuses what the form accepted.
// Lengths count characters the way Postgres does (code points), after trimming.
const LIMITS = { subject: 80, name: [2, 120], email: 200, address: [5, 500], notes: 2000 };
const PHONE_RE = /^0[0-9]{8,9}$/;
const EMAIL_RE = /^[^@\s?#&%/,;<>"]+@[^@\s?#&%/,;<>"]+[.][^@\s?#&%/,;<>"]+$/;
// Check constraints are named after their column (orders_phone_format, ...), so a refusal can point at its field.
// A refusal of items or photo_count can't say which figurine, so it gets the general message.
const CONSTRAINT_FIELDS = [
  ['customer_name', 'name'], ['phone', 'phone'], ['email', 'email'], ['address', 'address'], ['delivery', 'delivery'],
  ['notes', 'notes'],
];
// The fields after the figurines, in page order. Each figurine adds `<key>-kind`, `<key>-photos` and `<key>-subject`.
const ORDER_KEYS = ['name', 'phone', 'email', 'delivery', 'address', 'notes', 'consent'];

const MESSAGES = {
  kind: 'נא לבחור מה מדפיסים.',
  photos: 'נא לצרף לפחות תמונה אחת.',
  subject: `אפשר עד ${LIMITS.subject} תווים.`,
  name: 'נא לכתוב שם מלא.',
  phoneMissing: 'נא לכתוב מספר טלפון.',
  phone: 'מספר הטלפון לא נראה תקין. למשל: 050-1234567',
  emailMissing: 'נא לכתוב כתובת אימייל.',
  email: 'כתובת האימייל לא נראית תקינה.',
  delivery: 'נא לבחור איך לקבל את ההזמנה.',
  address: 'נא לכתוב כתובת מלאה: רחוב, מספר ועיר.',
  notes: `אפשר עד ${LIMITS.notes} תווים.`,
  consent: 'כדי להזמין צריך לאשר את תנאי ההזמנה.',
};
const PHOTO_TIPS = {
  pet: 'טיפ: תמונה שרואים בה את כל החיה, באור טוב, מהצד או באלכסון מלפנים. אפשר לצרף עוד תמונות מזוויות אחרות.',
  drawing: 'טיפ: מצלמים את הציור כשהוא מונח שטוח, ישר מלמעלה ובלי צל. דמות אחת בכל ציור.',
};
// What to do about a photo the browser couldn't prepare. It names no cause or device: most visitors are already
// on a phone, and the failure may be the format, the canvas running out of memory or the JPEG encoder.
const UNREADABLE_WAY = {
  one: 'אפשר לצלם מסך של התמונה ולצרף את צילום המסך, לשמור אותה כ-JPG, או לנסות מדפדפן אחר או ממכשיר אחר.',
  many: 'אפשר לצלם מסך של כל אחת מהן ולצרף את צילומי המסך, לשמור אותן כ-JPG, או לנסות מדפדפן אחר או ממכשיר אחר.',
};
const SAVING = 'שומרים את ההזמנה…';
const RESENDING = 'שולחים את ההזמנה מחדש…';
// A refused upload starts a fresh order only once the row may be past the bucket's 1-hour upload window
// (schema.sql); the margin covers the difference between this device's clock and the database's.
const UPLOAD_WINDOW_MINUTES = 55;
// minimumFractionDigits too: older Safari throws when only the maximum is below the currency's default 2.
const shekels = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', minimumFractionDigits: 0, maximumFractionDigits: 0,
});

const $ = (id) => document.getElementById(id);
const el = {
  deliveryNote: $('delivery-note'), closed: $('closed-notice'),
  footerContact: $('footer-contact'), footerBusiness: $('footer-business'),
  pending: $('pending'), pendingTitle: $('pending-title'), pendingCode: $('pending-code'), pendingText: $('pending-text'),
  pendingPay: $('pending-pay'), pendingDismiss: $('pending-dismiss'),
  thanks: $('thanks'), thanksTitle: $('thanks-title'), thanksText: $('thanks-text'), thanksCode: $('thanks-code'),
  thanksNew: $('thanks-new'),
  form: $('order-form'), formTitle: $('form-title'), fields: $('fields'), priceHint: $('price-hint'),
  figurines: $('figurines'), figurineTemplate: $('figurine-template'), addFigurine: $('add-figurine'),
  figurinesHint: $('figurines-hint'),
  name: $('customer-name'), phone: $('phone'), email: $('email'),
  pickupFrom: $('pickup-from'), pickupPointPrice: $('pickup-point-price'), addressField: $('address-field'),
  address: $('address'), notes: $('notes'), consent: $('consent'),
  alert: $('form-alert'), total: $('total'), submit: $('submit'), status: $('status'), help: $('status-help'),
  confirmation: $('confirmation'), confirmTitle: $('confirm-title'), confirmSummary: $('confirm-summary'),
  confirmCode: $('confirm-code'), copyCode: $('copy-code'),
  copyStatus: $('copy-status'), confirmPay: $('confirm-pay'), confirmNew: $('confirm-new'),
};

const site = readConfig(CONFIG);
const state = {
  // The figurines on the form, in order: { key, el: { root, title, … }, photos: [{ blob, thumbUrl }], removed }.
  // `key` names its fields and ids (fig3-kind, …) and never changes; its number on the page does.
  figurines: [],
  nextKey: 1,
  photoQueue: Promise.resolve(), // picks are prepared one batch after another, whichever figurine they're for
  preparing: false,
  submitting: false, // set synchronously: `disabled` only takes effect after the click that sets it
  // The order being saved: { row, blobs, inserted, unknown, assumed, uploaded: Set<n>, startedAt, rowAt }. Kept
  // across retries so a retry reuses its id and code; cleared once it's done or definitely not saved.
  attempt: null,
};

init();

function init() {
  fillFromConfig();
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitOrder();
  });
  el.form.addEventListener('input', (event) => {
    const key = event.target.dataset?.field;
    if (key && !key.endsWith('-photos')) clearFieldError(key);
  });
  el.form.addEventListener('change', (event) => {
    if (event.target.name === 'delivery') updateDelivery();
    const figurine = figurineOf(event.target);
    if (figurine && event.target.type === 'radio') updatePhotoTip(figurine);
  });
  el.addFigurine.addEventListener('click', () => addFigurine().el.title.focus());
  el.pendingDismiss.addEventListener('click', () => {
    // Marked paid-claimed rather than forgotten: the code stays for the thank-you note, until a new order replaces it.
    const saved = loadOrder();
    if (saved) storeOrder({ ...saved, paidClaimed: true });
    el.pending.hidden = true;
    el.formTitle.focus();
  });
  el.thanksNew.addEventListener('click', resetPage);
  el.confirmNew.addEventListener('click', resetPage);
  el.copyCode.addEventListener('click', copyCode);
  // Back from Grow, or from the thank-you, can restore this page from the back/forward cache exactly as it was
  // left, without running init() again. Re-check the stored order, or an order the customer has since paid for
  // would be offered for payment again.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refreshRestoredPage();
  });

  addFigurine();
  const saved = loadOrder();
  if (PAID_RETURN.test(location.search)) showThanks(saved);
  else showPending(saved);
  // index.html starts closed (notice shown, fields disabled), so a config.js or app.js that fails to load leaves
  // a closed page rather than a form that can't be sent.
  el.closed.hidden = site.open;
  el.fields.disabled = !site.open;
  updateDelivery();
  updateSubmit();
}

// ---------- Config ----------

/** Reads config.js. Orders stay closed until it names the project, its publishable key and a way to reach us. */
function readConfig(config) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  // A value that's set but unusable counts as missing. Say so, or the owner only finds out from confirmations
  // without a price or a Pay button. Named by key only: values don't belong in the console.
  const price = (key) => {
    const value = config?.prices?.[key] ?? null;
    if (value === null || value === '') return null;
    if (Number.isFinite(value) && value >= 0 && value < 100_000) return value;
    console.warn(`config.js: prices.${key} must be a plain number such as 160, without quotes. Until it is, it counts as `
      + 'not set, and the prices or totals that need it are hidden.');
    return null;
  };
  const growUrl = httpsUrl(text(config?.growUrl));
  if (!growUrl && text(config?.growUrl)) {
    console.warn('config.js: growUrl must be the full Grow link, starting with https://. Until it is, the confirmation '
      + 'says we\'ll be in touch about payment instead of showing the Pay button.');
  }
  const settings = {
    open: false,
    url: supabaseOrigin(text(config?.supabaseUrl)),
    key: text(config?.supabasePublishableKey),
    contact: { phone: text(config?.contact?.phone), email: text(config?.contact?.email) },
    businessName: text(config?.business?.name),
    deliveryDays: text(config?.deliveryDays),
    pickupFrom: text(config?.pickupFrom),
    prices: { one: price('one'), each: price('each'), pickupPoint: price('pickupPoint') },
    growUrl,
    growItems: { pet: text(config?.growItems?.pet), drawing: text(config?.growItems?.drawing) },
    growShipping: { pickup: text(config?.growShipping?.pickup), pickup_point: text(config?.growShipping?.pickup_point) },
    growCoupon: text(config?.growCoupon),
  };
  if (settings.key && !isPublishableKey(settings.key)) {
    console.error('config.js: supabasePublishableKey is a secret key, which bypasses every database rule. Orders stay '
      + 'closed. Put the publishable key (sb_publishable_…) there, and rotate the secret key in Supabase: it has been published.');
    return settings;
  }
  const missing = [];
  if (!settings.url) missing.push(text(config?.supabaseUrl) ? 'supabaseUrl (an https:// URL)' : 'supabaseUrl');
  if (!settings.key) missing.push('supabasePublishableKey');
  if (!settings.contact.phone && !settings.contact.email) missing.push('contact.phone or contact.email');
  if (missing.length) console.warn(`Orders are closed until config.js sets ${missing.join(', ')}.`);
  settings.open = missing.length === 0;
  return settings;
}

/** https only; plain http is accepted for a local mock. */
function supabaseOrigin(value) {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  } catch {
    return null;
  }
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

// A secret key (sb_secret_…, or a legacy JWT whose role isn't anon) bypasses Row Level Security, so a page
// that publishes one exposes every customer's details. Refuse to run with one.
function isPublishableKey(key) {
  if (key.startsWith('sb_secret_')) return false;
  const parts = key.split('.');
  if (parts.length !== 3) return true;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).role === 'anon';
  } catch {
    return false;
  }
}

function authHeaders() {
  return { apikey: site.key, Authorization: `Bearer ${site.key}` };
}

/** Prices, delivery time, contact details and the business name, wherever the page shows them. */
function fillFromConfig() {
  const { one, each, pickupPoint } = site.prices;
  if (one !== null) {
    el.priceHint.textContent = each !== null && each !== one
      ? `${shekels.format(one)} לפסלון. בהזמנה של 2 פסלונים ומעלה, ${shekels.format(each)} לכל פסלון.`
      : `${shekels.format(one)} לפסלון.`;
    el.priceHint.hidden = false;
  }
  if (pickupPoint !== null) {
    el.pickupPointPrice.textContent = `תוספת ${shekels.format(pickupPoint)}`;
    el.pickupPointPrice.hidden = false;
  }
  if (site.pickupFrom) el.pickupFrom.textContent = ` מ${site.pickupFrom}`;
  if (site.deliveryDays) {
    el.deliveryNote.replaceChildren('תוך ', deliveryDays(), ' ימי עסקים');
    el.deliveryNote.hidden = false;
  }
  if (hasContact()) {
    el.footerContact.append('יצירת קשר: ', ...contactNodes());
    el.footerContact.hidden = false;
    el.closed.append(' בינתיים אפשר לפנות אלינו: ', ...contactNodes());
    el.help.append('לעזרה אפשר לפנות אלינו: ', ...contactNodes());
  }
  if (site.businessName) {
    el.footerBusiness.textContent = site.businessName;
    el.footerBusiness.hidden = false;
  }
}

function hasContact() {
  return Boolean(site.contact.phone || site.contact.email);
}

/** The contact details as links for a sentence, each isolated LTR so a phone's digit groups keep their order. */
function contactNodes() {
  const { phone, email } = site.contact;
  const links = [];
  // nowrap: a line break after the phone's hyphen would split the number in the middle of a sentence
  if (phone) {
    links.push(make('a', { href: `tel:${phone.replace(/[^0-9+]/g, '')}`, dir: 'ltr', className: 'nowrap', textContent: phone }));
  }
  if (email) links.push(make('a', { href: `mailto:${email}`, dir: 'ltr', textContent: email }));
  return links.flatMap((node, i) => (i ? [' · ', node] : [node]));
}

/** The delivery range ("7–10") kept left to right inside Hebrew; an en dash would otherwise flip it to "10–7". */
function deliveryDays() {
  return make('bdi', { dir: 'ltr', textContent: site.deliveryDays });
}

/** A new element with the given properties. Text always goes in as textContent, never as HTML. */
function make(tag, properties) {
  return Object.assign(document.createElement(tag), properties);
}

// ---------- Prices ----------

/** What each figurine costs in an order of `count`, or null if that price isn't set. */
function unitPrice(count) {
  const { one, each } = site.prices;
  return count > 1 && each !== null ? each : one;
}

/** The figurines plus delivery to a pickup point, or null if a price it needs isn't set. */
function orderTotal(count, delivery) {
  const unit = unitPrice(count);
  const shipping = delivery === 'pickup_point' ? site.prices.pickupPoint : 0;
  if (unit === null || shipping === null) return null;
  return Math.round((unit * count + shipping) * 100) / 100;
}

/** The total under the form, kept up to date as figurines are added and the delivery chosen. */
function updateTotal() {
  const count = state.figurines.length;
  const shipped = deliveryValue() === 'pickup_point';
  // Hidden when a price it needs isn't set, as the row's price_ils is then null too: a total without the delivery
  // fee would be wrong.
  const total = orderTotal(count, shipped ? 'pickup_point' : 'pickup');
  el.total.hidden = total === null;
  if (total === null) return;
  const unit = unitPrice(count);
  const parts = [count > 1 ? `${count} פסלונים, ${shekels.format(unit)} לפסלון` : `פסלון ${shekels.format(unit)}`];
  if (shipped) parts.push(`משלוח לנקודת איסוף ${shekels.format(site.prices.pickupPoint)}`);
  el.total.replaceChildren(make('strong', { textContent: `סה״כ ${shekels.format(total)}` }));
  // A single figurine picked up costs just its price: nothing to break down.
  if (count > 1 || shipped) el.total.append(` (${parts.join(' + ')})`);
}

// ---------- Figurines ----------

/** Adds a figurine to the form, made from the template, and returns it. */
function addFigurine() {
  // The button hides at the limit; this holds even if it's clicked some other way.
  if (state.figurines.length >= MAX_FIGURINES) return state.figurines.at(-1);
  const key = `fig${state.nextKey++}`;
  const root = el.figurineTemplate.content.firstElementChild.cloneNode(true);
  const part = (role) => root.querySelector(`[data-role="${role}"]`);
  const figurine = {
    key,
    photos: [],
    removed: false,
    el: {
      root, title: part('title'), remove: part('remove'), kinds: part('kinds'), tip: part('tip'), thumbs: part('thumbs'),
      input: part('input'), button: part('button'), status: part('status'), subject: part('subject'),
    },
  };
  // Every id, name and field key is the figurine's own, so labels, errors and radio groups never mix between figurines.
  part('title').id = `${key}-title`;
  part('kinds-legend').id = `${key}-kinds-legend`;
  figurine.el.kinds.setAttribute('aria-labelledby', `${key}-title ${key}-kinds-legend`);
  figurine.el.kinds.setAttribute('aria-describedby', `${key}-kind-error`);
  for (const radio of figurine.el.kinds.querySelectorAll('input')) {
    radio.name = `${key}-kind`;
    radio.dataset.field = `${key}-kind`;
  }
  part('kind-error').id = `${key}-kind-error`;
  part('photos-hint').id = `${key}-photos-hint`;
  figurine.el.tip.id = `${key}-tip`;
  part('photos-error').id = `${key}-photos-error`;
  figurine.el.input.id = `${key}-photos-input`;
  figurine.el.input.dataset.field = `${key}-photos`;
  figurine.el.input.setAttribute('aria-describedby', `${key}-photos-hint ${key}-tip ${key}-photos-error`);
  figurine.el.button.htmlFor = figurine.el.input.id;
  figurine.el.subject.id = `${key}-subject`;
  figurine.el.subject.dataset.field = `${key}-subject`;
  figurine.el.subject.setAttribute('aria-describedby', `${key}-subject-error`);
  part('subject-label').htmlFor = figurine.el.subject.id;
  part('subject-error').id = `${key}-subject-error`;

  figurine.el.input.addEventListener('change', () => {
    const files = [...figurine.el.input.files];
    figurine.el.input.value = ''; // so picking the same photo again fires another change
    state.photoQueue = state.photoQueue.then(() => addPhotos(figurine, files));
  });
  figurine.el.remove.addEventListener('click', () => removeFigurine(figurine));

  state.figurines.push(figurine);
  el.figurines.append(root);
  renumberFigurines();
  updateTotal();
  return figurine;
}

function removeFigurine(figurine) {
  const index = state.figurines.indexOf(figurine);
  if (index < 0 || state.figurines.length === 1) return;
  figurine.removed = true; // a pick still being prepared for it is dropped
  for (const photo of figurine.photos) URL.revokeObjectURL(photo.thumbUrl);
  figurine.el.root.remove();
  state.figurines.splice(index, 1);
  renumberFigurines();
  updateTotal();
  if (!el.form.querySelector('[aria-invalid="true"]')) el.alert.textContent = '';
  // The button that had focus is gone: go to the figurine now in its place, or else the one before it.
  (state.figurines[index] ?? state.figurines[index - 1]).el.title.focus();
}

/** Numbers the figurines 1, 2, … after one is added or removed, and offers removal only while there are two or more. */
function renumberFigurines() {
  const count = state.figurines.length;
  state.figurines.forEach((figurine, i) => {
    figurine.el.title.textContent = `פסלון ${i + 1}`;
    figurine.el.remove.hidden = count === 1;
    figurine.el.remove.setAttribute('aria-label', `הסרת פסלון ${i + 1}`);
    renderThumbs(figurine); // their labels name the figurine's number
  });
  el.addFigurine.hidden = count >= MAX_FIGURINES;
  el.figurinesHint.textContent = count >= MAX_FIGURINES
    ? `זה המקסימום להזמנה אחת: ${MAX_FIGURINES} פסלונים. לעוד פסלונים אפשר לשלוח הזמנה נוספת.`
    : `אפשר עד ${MAX_FIGURINES} פסלונים בהזמנה אחת.`;
}

// Function declarations rather than arrow constants, here and below: init() runs at the top of the module, before
// any const further down is initialised.
function figurineOf(node) {
  return state.figurines.find((figurine) => figurine.el.root.contains(node));
}

function figurineKind(figurine) {
  return figurine.el.kinds.querySelector('input:checked')?.value ?? '';
}

function updatePhotoTip(figurine) {
  const tip = PHOTO_TIPS[figurineKind(figurine)] ?? '';
  figurine.el.tip.textContent = tip;
  figurine.el.tip.hidden = !tip;
}

// ---------- Photos ----------

/** Prepares picked photos one at a time: a phone can't hold several full-size decodes at once. */
async function addPhotos(figurine, files) {
  if (figurine.removed) return;
  state.preparing = true;
  updateSubmit();
  const failed = []; // file names
  let overflow = false;
  for (const file of files) {
    if (figurine.removed) break;
    if (figurine.photos.length >= MAX_PHOTOS) {
      overflow = true;
      break;
    }
    figurine.el.status.textContent = 'מכינים את התמונות…';
    try {
      const { blob, thumb } = await preparePhoto(file);
      if (figurine.removed) break;
      figurine.photos.push({ blob, thumbUrl: URL.createObjectURL(thumb) });
      renderThumbs(figurine);
      clearFieldError(`${figurine.key}-photos`);
    } catch (err) {
      console.warn(`Photo "${file.name}" couldn't be prepared:`, err);
      failed.push(file.name);
    }
  }
  if (!figurine.removed) {
    figurine.el.status.replaceChildren(...photoNotes(failed, overflow));
    figurine.el.status.classList.toggle('error', failed.length > 0);
  }
  state.preparing = false;
  updateSubmit();
}

/**
 * What went wrong with a pick. A photo that failed gets no thumbnail, so it's named by its file name (what the
 * customer saw when picking it): a number would point at a different, working thumbnail. Each name is isolated
 * so a Latin file name doesn't reorder the Hebrew around it.
 */
function photoNotes(failed, overflow) {
  const nodes = [];
  if (failed.length) {
    const names = failed.filter(Boolean)
      .flatMap((name, i) => [i ? ', ' : ' ', make('bdi', { dir: 'auto', textContent: name })]);
    nodes.push(failed.length === 1 ? 'לא הצלחנו לפתוח את התמונה' : 'לא הצלחנו לפתוח את התמונות', ...names,
      ' בדפדפן הזה. ', failed.length === 1 ? UNREADABLE_WAY.one : UNREADABLE_WAY.many);
    if (hasContact()) nodes.push(' בכל שאלה: ', ...contactNodes(), '.');
  }
  if (overflow) {
    nodes.push(nodes.length ? ' ' : '', `אפשר לצרף עד ${MAX_PHOTOS} תמונות לכל פסלון. לעוד פסלון, "הוספת פסלון" למטה.`);
  }
  return nodes;
}

/**
 * Decodes a photo (createImageBitmap applies its EXIF rotation), scales it to MAX_SIDE on white, and returns it as
 * a JPEG Blob, with a small one for the thumbnail. The full-size decode can take 50–200 MB on a phone, so it's
 * freed straight away.
 */
async function preparePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const thumbCanvas = document.createElement('canvas');
  try {
    drawOnWhite(canvas, bitmap, MAX_SIDE);
    drawOnWhite(thumbCanvas, bitmap, THUMB_SIDE);
  } finally {
    bitmap.close();
  }
  try {
    let blob = null;
    for (const quality of JPEG_QUALITIES) {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('The browser could not encode the photo');
      if (blob.size <= REENCODE_BYTES) break;
    }
    if (blob.size > MAX_BYTES) throw new Error(`Still ${blob.size} bytes at the lowest quality`);
    const thumb = await new Promise((resolve) => thumbCanvas.toBlob(resolve, 'image/jpeg', 0.8));
    return { blob, thumb: thumb ?? blob };
  } finally {
    // releases the pixels now; iOS Safari otherwise holds them for a while
    canvas.width = canvas.height = 0;
    thumbCanvas.width = thumbCanvas.height = 0;
  }
}

/** Draws the bitmap on the canvas, scaled down to `maxSide`, on white: a transparent PNG would turn black in a JPEG. */
function drawOnWhite(canvas, bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

function renderThumbs(figurine) {
  const n = state.figurines.indexOf(figurine) + 1;
  figurine.el.thumbs.replaceChildren(...figurine.photos.map((photo, i) => {
    const remove = make('button', {
      type: 'button', className: 'thumb-remove', textContent: '×', onclick: () => removePhoto(figurine, i),
    });
    remove.setAttribute('aria-label', `הסרת תמונה ${i + 1} של פסלון ${n}`);
    const item = make('li');
    item.append(make('img', { src: photo.thumbUrl, alt: `תמונה ${i + 1} של פסלון ${n}` }), remove);
    return item;
  }));
  figurine.el.button.textContent = figurine.photos.length ? 'הוספת תמונות' : 'בחירת תמונות';
}

function removePhoto(figurine, index) {
  const [photo] = figurine.photos.splice(index, 1);
  URL.revokeObjectURL(photo.thumbUrl);
  figurine.el.status.textContent = '';
  renderThumbs(figurine);
  figurine.el.input.focus(); // the button that had focus is gone
}

// ---------- Delivery ----------

/** 'pickup', 'pickup_point', or '' before one is chosen. */
function deliveryValue() {
  return el.form.elements.delivery.value;
}

/** The address is asked for only when the order is sent to a pickup point. */
function updateDelivery() {
  el.addressField.hidden = deliveryValue() !== 'pickup_point';
  if (el.addressField.hidden) setFieldError('address', null);
  updateTotal();
}

// ---------- Validation ----------

/** Every field that can show an error, in page order. */
function fieldKeys() {
  return [...state.figurines.flatMap(({ key }) => [`${key}-kind`, `${key}-photos`, `${key}-subject`]), ...ORDER_KEYS];
}

/** Checks the form like the database will. Returns the row's fields, or null after showing what to fix. */
function validateForm() {
  updateDelivery(); // in step with the radios, even if the browser restored them without a change event
  const chars = (text) => [...text].length;
  const figurines = state.figurines.map((figurine) => ({
    figurine, kind: figurineKind(figurine), subject: figurine.el.subject.value.trim(),
  }));
  const values = {
    name: el.name.value.trim(),
    phone: normalisePhone(el.phone.value),
    email: el.email.value.trim(),
    delivery: deliveryValue(),
    address: el.address.value.trim(),
    notes: el.notes.value.trim(),
  };
  const errors = {};
  for (const { figurine: { key, photos }, kind, subject } of figurines) {
    if (kind !== 'pet' && kind !== 'drawing') errors[`${key}-kind`] = MESSAGES.kind;
    if (!photos.length) errors[`${key}-photos`] = MESSAGES.photos;
    if (chars(subject) > LIMITS.subject) errors[`${key}-subject`] = MESSAGES.subject;
  }
  if (chars(values.name) < LIMITS.name[0] || chars(values.name) > LIMITS.name[1]) errors.name = MESSAGES.name;
  if (!values.phone) errors.phone = MESSAGES.phoneMissing;
  else if (!PHONE_RE.test(values.phone)) errors.phone = MESSAGES.phone;
  if (!values.email) errors.email = MESSAGES.emailMissing;
  else if (chars(values.email) > LIMITS.email || !EMAIL_RE.test(values.email)) errors.email = MESSAGES.email;
  if (values.delivery !== 'pickup' && values.delivery !== 'pickup_point') errors.delivery = MESSAGES.delivery;
  const shipped = values.delivery === 'pickup_point';
  if (shipped && (chars(values.address) < LIMITS.address[0] || chars(values.address) > LIMITS.address[1])) {
    errors.address = MESSAGES.address;
  }
  if (chars(values.notes) > LIMITS.notes) errors.notes = MESSAGES.notes;
  if (!el.consent.checked) errors.consent = MESSAGES.consent;

  const keys = fieldKeys();
  for (const key of keys) setFieldError(key, errors[key]);
  const invalid = keys.filter((key) => errors[key]);
  if (invalid.length) {
    el.alert.textContent = invalid.length === 1
      ? 'ההזמנה לא נשלחה: שדה אחד צריך תיקון.'
      : `ההזמנה לא נשלחה: ${invalid.length} שדות צריכים תיקון.`;
    focusField(invalid[0]);
    return null;
  }
  return {
    items: figurines.map(({ figurine, kind, subject }) => ({ kind, subject_name: subject || null, photos: figurine.photos.length })),
    customer_name: values.name,
    phone: values.phone,
    email: values.email,
    delivery: values.delivery,
    address: shipped ? values.address : null,
    notes: values.notes || null,
    photo_count: figurines.reduce((sum, { figurine }) => sum + figurine.photos.length, 0),
    price_ils: orderTotal(figurines.length, values.delivery),
    user_agent: navigator.userAgent.slice(0, 500),
  };
}

/** Digits only, with the international 972 prefix as the local 0 (Grow shows phones as 05XXXXXXXX). */
function normalisePhone(value) {
  return value.replace(/\D/g, '').replace(/^(?:00)?972/, '0')
    .replace(/^00/, '0'); // "+972 (0)50…" leaves a doubled 0
}

function setFieldError(key, message) {
  const error = $(`${key}-error`);
  if (!error) return; // a figurine removed meanwhile
  error.textContent = message ?? '';
  error.hidden = !message;
  for (const target of el.form.querySelectorAll(`[data-field="${key}"]`)) {
    if (message) target.setAttribute('aria-invalid', 'true');
    else target.removeAttribute('aria-invalid');
  }
}

/** Clears a field's error as it's edited, and the summary once nothing is left to fix. */
function clearFieldError(key) {
  setFieldError(key, null);
  if (!el.form.querySelector('[aria-invalid="true"]')) el.alert.textContent = '';
}

function focusField(key) {
  el.form.querySelector(`[data-field="${key}"]`)?.focus();
}

// ---------- Submitting ----------

async function submitOrder() {
  if (state.submitting || state.preparing || !site.open) return;
  state.submitting = true;
  el.alert.textContent = '';
  updateSubmit();
  try {
    if (!state.attempt) {
      const fields = validateForm();
      if (!fields) return;
      state.attempt = newAttempt(fields, state.figurines.flatMap((figurine) => figurine.photos.map((photo) => photo.blob)));
    }
    await saveOrder();
  } finally {
    state.submitting = false;
    updateSubmit();
  }
}

function newAttempt(fields, blobs) {
  return {
    row: { id: crypto.randomUUID(), code: newCode(), ...fields },
    blobs,
    inserted: false,
    unknown: false, // an insert's outcome was lost: from then on the id and code never change
    assumed: false, // counted as saved from a code clash after a lost answer: the row may be someone else's
    uploaded: new Set(),
    startedAt: Date.now(), // before the first insert request
    rowAt: null, // the earliest the row can have been created, by this device's clock
  };
}

// Six digits, never a leading 0: it's typed into Grow's "מספר הזמנה" field, often on a Hebrew keyboard.
function newCode() {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(100_000 + (n % 900_000));
}

/** Inserts the row (unless saved already), uploads the photos, then shows the confirmation. */
async function saveOrder() {
  el.fields.disabled = true; // the saved row wouldn't follow edits
  // At most one fresh order per click, so a refusal that every order gets can't pile up rows.
  for (let restarted = false; ; restarted = true) {
    const attempt = state.attempt;
    if (!attempt.inserted && !(await insertOrder(attempt, restarted ? RESENDING : SAVING))) return;
    const result = await uploadPhotos(attempt);
    if (result === 'done') return showConfirmation(attempt);
    if (result !== 'refused') return;
    // The bucket's rule refused this order's photos. A fresh order (new id and code, the same details and photos)
    // helps only when the refusal is about this row: its upload hour has passed (a tab left in the background),
    // or it was never ours (a code clash after a lost answer, see insertOrder). Any other cause (the storage
    // fallback policy missing, the bucket at its 800 MB cap) refuses every order alike: a fresh one would only
    // leave another photo-less row and use up the hourly order cap for everyone. rowAt is the earliest the row
    // can have been created, so minutesOld overstates its age: below the threshold the hour can't have passed.
    const minutesOld = (Date.now() - attempt.rowAt) / 60_000;
    const notOurs = attempt.assumed && attempt.uploaded.size === 0;
    if (!restarted && (minutesOld >= UPLOAD_WINDOW_MINUTES || notOurs)) {
      console.warn(`Order ${attempt.row.code}: the bucket no longer takes its photos; sending a new order.`);
      state.attempt = newAttempt(rowFields(attempt.row), attempt.blobs);
      continue;
    }
    // Keep this order: a retry uploads into the same row, and only starts a new one once its hour may have passed.
    const n = attempt.uploaded.size + 1; // uploads go in order and stop at the first refusal
    console.warn(`Order ${attempt.row.code}: the bucket refused photo ${n} at most ${Math.ceil(minutesOld)} min after `
      + 'the order was saved, before its upload hour could have passed, so the order is kept for a retry. Likely causes: '
      + 'the storage fallback policy is needed (SETUP.md, "Storage fallback policy"), or the bucket holds 800 MB or more.');
    setStatus(`העלאת ${photoName(attempt.row.items, n)} נכשלה. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, צרו קשר.`,
      { error: true });
    return;
  }
}

function rowFields({ id, code, ...fields }) {
  return fields;
}

/**
 * Inserts the row, handling each outcome; returns true once it's saved, or false after saying what to do.
 * `status` is shown while it's saving (a restart says so, and it must not be replaced in the same task).
 */
async function insertOrder(attempt, status) {
  setStatus(status);
  let retried = false;
  let codeTries = 1;
  for (;;) {
    const sentAt = Date.now();
    const { outcome, field } = await postRow(attempt.row);
    if (outcome === 'saved' || outcome === 'exists') {
      attempt.inserted = true;
      // A 201 means this very request created the row; 'exists' means an earlier one of this attempt did.
      attempt.rowAt = outcome === 'saved' ? sentAt : attempt.startedAt;
      return true;
    }
    if (outcome === 'unknown') {
      attempt.unknown = true;
      if (!retried) {
        retried = true;
        continue;
      }
      setStatus('לא הצלחנו לוודא שההזמנה נשמרה, כנראה בגלל בעיית תקשורת. אפשר לנסות שוב: ההזמנה לא תישמר פעמיים.',
        { error: true });
      return false;
    }
    if (outcome === 'code-taken') {
      // After a lost answer this is most likely our own row: Postgres may check the code's index before the
      // primary key's. If it isn't ours, the first upload is refused and a fresh attempt starts (see saveOrder).
      if (attempt.unknown) {
        attempt.inserted = true;
        attempt.assumed = true;
        attempt.rowAt = attempt.startedAt;
        return true;
      }
      if (codeTries++ < CODE_TRIES) {
        attempt.row.code = newCode();
        continue;
      }
    }
    // Definitely not saved: the form opens again for a fix (or a later try), as a new attempt.
    state.attempt = null;
    el.fields.disabled = false;
    if (outcome === 'busy') {
      setStatus('יש כרגע עומס בהזמנות, נסו שוב בעוד כמה דקות או צרו קשר.', { error: true });
    } else if (field) {
      setFieldError(field, MESSAGES[field]);
      setStatus('חלק מהפרטים לא תקינים. נא לבדוק את השדה המסומן ולשלוח שוב.', { error: true });
      focusField(field);
    } else {
      setStatus('שמירת ההזמנה נכשלה. נסו שוב, ואם זה חוזר, צרו קשר.', { error: true });
    }
    return false;
  }
}

/**
 * One insert request, classified:
 * - saved: 201;
 * - unknown: no answer, a timeout or a 5xx, so it may have been saved: retry with the same id and code;
 * - exists: the primary key is taken, so an earlier try with this id was saved;
 * - code-taken: another order has this code;
 * - busy: the hourly order cap (P0001 orders_rate_limit, the only P0001 a single insert can hit);
 * - invalid: any other refusal; nothing was saved. `field` names the field when the constraint shows it.
 */
async function postRow(row) {
  let response;
  try {
    response = await fetch(`${site.url}/rest/v1/orders`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
      signal: timeoutSignal(INSERT_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('Saving the order got no answer:', err);
    return { outcome: 'unknown' };
  }
  if (response.ok) return { outcome: 'saved' };
  if (response.status >= 500) return { outcome: 'unknown' };
  const error = await response.json().catch(() => ({}));
  console.warn(`Saving the order was refused (${response.status}):`, error);
  const text = `${error.message ?? ''} ${error.details ?? ''}`;
  if (error.code === '23505' && text.includes('orders_pkey')) return { outcome: 'exists' };
  if (error.code === '23505' && text.includes('orders_code_key')) return { outcome: 'code-taken' };
  if (error.code === 'P0001' || response.status === 429) return { outcome: 'busy' };
  // Only the constraint's own name: the message's other words, or a row in its details, could name another column.
  const constraint = /constraint "([a-z_]+)"/.exec(error.message ?? '')?.[1] ?? '';
  return { outcome: 'invalid', field: CONSTRAINT_FIELDS.find(([column]) => constraint.includes(column))?.[1] };
}

/**
 * Uploads the photos not stored yet, in order. Returns 'done'; 'refused' (the bucket's rule said no, and saveOrder
 * decides what that means); or 'stopped' after saying what to do.
 */
async function uploadPhotos(attempt) {
  const total = attempt.blobs.length;
  window.addEventListener('beforeunload', keepPageOpen);
  try {
    for (let n = 1; n <= total; n++) {
      if (attempt.uploaded.has(n)) continue;
      setStatus(`מעלים תמונה ${n} מתוך ${total}. נא להשאיר את הדף פתוח עד סיום ההעלאה.`);
      let result = await putPhoto(attempt.row.id, n, attempt.blobs[n - 1]);
      if (result === 'retry') result = await putPhoto(attempt.row.id, n, attempt.blobs[n - 1]);
      if (result === 'stored') {
        attempt.uploaded.add(n);
        continue;
      }
      if (result === 'refused') return 'refused';
      const name = photoName(attempt.row.items, n);
      setStatus(result === 'retry'
        ? `העלאת ${name} נכשלה, כנראה בגלל בעיית תקשורת. אפשר לנסות שוב: ההעלאה תמשיך מאותה נקודה.`
        : `העלאת ${name} נכשלה. אפשר לנסות שוב, ואם זה חוזר, צרו קשר.`, { error: true });
      return 'stopped';
    }
    return 'done';
  } finally {
    window.removeEventListener('beforeunload', keepPageOpen);
  }
}

/**
 * Photo `n` of the order (numbered on through it) as its thumbnail names it: "תמונה 2 של פסלון 3", or "תמונה 2"
 * when there's one figurine. The order's own number would point at a different thumbnail.
 */
function photoName(items, n) {
  let first = 1;
  for (const [i, item] of items.entries()) {
    if (n < first + item.photos) return items.length > 1 ? `תמונה ${n - first + 1} של פסלון ${i + 1}` : `תמונה ${n}`;
    first += item.photos;
  }
  return `תמונה ${n}`;
}

/**
 * One upload: 'stored', 'retry' (no answer, timeout, 5xx), 'refused' (403: the bucket's rule said no, which may or
 * may not be this order's hour having passed) or 'failed'.
 */
async function putPhoto(id, n, blob) {
  let response;
  try {
    response = await fetch(`${site.url}/storage/v1/object/order-photos/${id}/${n}.jpg`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
      body: blob,
      signal: timeoutSignal(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`Uploading photo ${n} got no answer:`, err);
    return 'retry';
  }
  if (response.ok) return 'stored';
  // Storage answers most errors with HTTP 400 and puts the real status in the body.
  const error = await response.json().catch(() => ({}));
  const status = Number(error.statusCode ?? response.status);
  if (status === 409) return 'stored'; // Duplicate: an earlier try stored it and its answer was lost
  if (status === 403) return 'refused';
  if (status >= 500 || response.status >= 500) return 'retry';
  console.warn(`Uploading photo ${n} was refused (${response.status}):`, error);
  return 'failed';
}

function keepPageOpen(event) {
  event.preventDefault();
  event.returnValue = ''; // older Chrome and Safari only ask when this is set
}

function timeoutSignal(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const controller = new AbortController(); // Safari before 16
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function setStatus(message, { error = false } = {}) {
  el.status.textContent = message;
  el.status.classList.toggle('error', error);
  el.help.hidden = !error || !hasContact();
}

function updateSubmit() {
  el.submit.disabled = !site.open || state.submitting || state.preparing;
  el.submit.textContent = state.submitting ? 'שולחים…' : state.attempt ? 'ניסיון נוסף' : 'שליחת ההזמנה';
}

// ---------- Confirmation, payment and coming back ----------

function showConfirmation(attempt) {
  const { code, items, delivery, price_ils: total } = attempt.row;
  const kinds = { pet: 0, drawing: 0 };
  for (const item of items) kinds[item.kind]++;
  const order = {
    code, paymentUrl: site.growUrl, count: items.length, kinds, delivery, total, at: Date.now(), paidClaimed: false,
  };
  storeOrder(order);
  state.attempt = null;
  setStatus('');
  el.confirmSummary.textContent = orderSummary(order);
  el.confirmCode.textContent = code;
  el.copyStatus.textContent = '';
  renderPayment(el.confirmPay, order);
  el.form.hidden = true;
  el.pending.hidden = true;
  el.confirmation.hidden = false;
  el.confirmTitle.focus();
}

/** "3 פסלונים · משלוח לנקודת איסוף · סה״כ ₪475" */
function orderSummary({ count, delivery, total }) {
  const parts = [count > 1 ? `${count} פסלונים` : 'פסלון אחד'];
  if (delivery === 'pickup') parts.push(`איסוף עצמי${site.pickupFrom ? ` מ${site.pickupFrom}` : ''}`);
  if (delivery === 'pickup_point') parts.push('משלוח לנקודת איסוף');
  if (Number.isFinite(total)) parts.push(`סה״כ ${shekels.format(total)}`);
  return parts.join(' · ');
}

/**
 * The Pay button and what to do on Grow's page, or a note that we'll be in touch when there's no Grow link.
 * `order` is what storeOrder keeps. `quiet` draws a plain button, for the pending panel, where the order may well be
 * paid already.
 */
function renderPayment(container, order, { quiet = false } = {}) {
  const paymentUrl = httpsUrl(order.paymentUrl);
  if (!paymentUrl) {
    const note = make('p', { textContent: 'ניצור איתכם קשר לגבי התשלום.' });
    if (hasContact()) note.append(' בכל שאלה: ', ...contactNodes());
    container.replaceChildren(note);
    return;
  }
  const pay = make('a', { className: quiet ? 'button' : 'button brick green', href: paymentUrl, textContent: 'לתשלום ב-Grow' });
  pay.addEventListener('click', (event) => goToPayment(event, order.code));
  const steps = make('ul', { className: 'pay-steps' });
  const step = (...content) => {
    const item = make('li');
    item.append(...content);
    steps.append(item);
  };
  for (const content of growSteps(order)) step(...content);
  if (Number.isFinite(order.total)) step('בודקים שהסכום לתשלום הוא ', make('strong', { textContent: shekels.format(order.total) }), '.');
  // The copy can fail without a sign (in-app browsers often refuse it), and the clipboard may then hold an older
  // code. So the step shows the code and asks to check the paste, rather than promising it was copied.
  step('מדביקים בשדה "מספר הזמנה" את מספר ההזמנה, ', make('bdi', { className: 'inline-code', textContent: order.code }),
    ' (הכפתור מעתיק אותו), ובודקים שהודבק המספר הזה. אחרת מקלידים אותו.');
  container.replaceChildren(
    pay,
    make('p', { className: 'hint', textContent: 'בעמוד התשלום:' }),
    steps,
    make('p', { className: 'hint', textContent: 'כדאי גם לצלם מסך של המספר, ולשלם עם אותו שם ואותו טלפון.' }),
  );
}

/**
 * What to choose on Grow's page before the total, as steps (each a list of nodes): its product for each kind of
 * figurine with the quantity, its shipping option, and the coupon for an order of 2 or more. A step is left out
 * when config.js doesn't name what it needs, or (for an order stored before `kinds` was kept) the order doesn't say.
 */
function growSteps({ count, kinds, delivery }) {
  const quoted = (name) => make('bdi', { textContent: `"${name}"` });
  const steps = [];
  const lines = Object.entries(kinds ?? {}).filter(([, n]) => n > 0).map(([kind, n]) => [site.growItems[kind], n]);
  if (lines.length && lines.every(([name]) => name)) {
    steps.push(['בוחרים ', ...lines.flatMap(([name, n], i) => [i ? ', ו' : '', quoted(name), ` בכמות ${n}`]), '.']);
  }
  const shipping = site.growShipping[delivery];
  if (shipping) steps.push(['בשדה "משלוח" בוחרים ', quoted(shipping), '.']);
  // Only while the site's own price for 2 or more is lower: the coupon is what makes Grow's total match it.
  const { one, each } = site.prices;
  if (count > 1 && site.growCoupon && one !== null && each !== null && each < one) {
    steps.push(['לוחצים "יש לי קוד קופון!" ומזינים ',
      make('bdi', { dir: 'ltr', className: 'inline-code', textContent: site.growCoupon }), ', ההנחה להזמנה של 2 פסלונים ומעלה.']);
  }
  return steps;
}

// Grow's page asks for the order code and opens in this tab, so the code goes to the clipboard on the way.
// The copy must start inside the click: browsers only allow clipboard writes during a user gesture.
function goToPayment(event, code) {
  const copied = navigator.clipboard?.writeText(code).catch(() => {});
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; // opening it elsewhere
  event.preventDefault();
  const { href } = event.currentTarget;
  // Leaving at once can drop a write that's still pending, so give it a moment.
  Promise.race([copied, new Promise((resolve) => setTimeout(resolve, 500))]).then(() => location.assign(href));
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(el.confirmCode.textContent);
    el.copyStatus.textContent = 'הועתק';
  } catch {
    el.copyStatus.textContent = 'לא הצלחנו להעתיק. אפשר לסמן את המספר ולהעתיק.';
  }
}

/**
 * The last order from this browser, for 24 hours unless it's marked paid: Back from Grow, a reload or an evicted
 * tab. The site can't know whether it was paid (only Grow's optional `?paid` redirect hints at it), so the panel
 * says both: pay here if you haven't, don't pay again if you have.
 */
function showPending(saved) {
  el.pending.hidden = !isPending(saved);
  if (el.pending.hidden) return;
  const paymentUrl = httpsUrl(saved.paymentUrl);
  el.pendingCode.textContent = saved.code;
  el.pendingText.replaceChildren(...(paymentUrl ? [
    'אם עוד לא שילמתם, אפשר לשלם כאן. כבר שילמתם? אין צורך לשלם שוב: Grow שלחו לכם קבלה ', bySms(),
    ' או במייל, ואנחנו נאשר את ההזמנה וניצור איתכם קשר.',
    ...(hasContact() ? [' בכל שאלה: ', ...contactNodes(), '.'] : []),
  ] : []));
  el.pendingText.hidden = !paymentUrl; // without a Grow link, renderPayment says we'll be in touch
  renderPayment(el.pendingPay, saved, { quiet: true });
}

function showThanks(saved) {
  history.replaceState(history.state, '', location.pathname + location.hash);
  if (saved) storeOrder({ ...saved, paidClaimed: true }); // the pending panel stops showing
  el.thanksText.replaceChildren(
    'אם התשלום הושלם, Grow שלחו לכם קבלה ', bySms(), ' או במייל. נאשר את ההזמנה וניצור קשר',
    ...(site.deliveryDays
      ? [', ותוך ', deliveryDays(), ' ימי עסקים מההזמנה היא תצא למשלוח או תהיה מוכנה לאיסוף.']
      : ['.']),
    ' אין צורך לשלם שוב',
    ...(hasContact() ? ['; בכל שאלה: ', ...contactNodes(), '.'] : ['.']),
  );
  if (saved && Date.now() - saved.at < PAID_CODE_SHOWN_MS) {
    el.thanksCode.querySelector('bdi').textContent = saved.code;
    el.thanksCode.hidden = false;
  }
  el.form.hidden = el.pending.hidden = el.confirmation.hidden = true;
  el.thanks.hidden = false;
}

/** "ב-SMS" kept on one line: browsers may break after the hyphen. */
function bySms() {
  return make('span', { className: 'nowrap', textContent: 'ב-SMS' });
}

/**
 * A page restored from the back/forward cache shows what a fresh load would: the thank-you for an order marked
 * paid since (by the `?paid` page or the panel's button), else the form with the pending panel. A confirmation
 * left as it was would still say "next: payment" to someone coming back from Grow's own success page.
 */
function refreshRestoredPage() {
  if (!el.thanks.hidden) return; // offers nothing to pay
  const saved = loadOrder();
  if (el.confirmation.hidden) return showPending(saved); // the form as it was left; only the panel may change
  // Only an order the browser still holds is replaced: with storage blocked the confirmation is the only copy of the code.
  if (saved?.code !== el.confirmCode.textContent) return;
  if (saved.paidClaimed) {
    showThanks(saved);
    el.thanksTitle.focus();
  } else if (isPending(saved)) {
    resetPage(); // the order is saved: the form is for the next one
    showPending(saved);
    el.pendingTitle.focus();
  }
}

function isPending(saved) {
  return Boolean(saved) && !saved.paidClaimed && Date.now() - saved.at < PENDING_SHOWN_MS;
}

function resetPage() {
  for (const figurine of state.figurines) {
    figurine.removed = true;
    for (const photo of figurine.photos) URL.revokeObjectURL(photo.thumbUrl);
  }
  state.figurines = [];
  el.figurines.replaceChildren();
  state.attempt = null;
  el.form.reset();
  addFigurine();
  for (const key of ORDER_KEYS) setFieldError(key, null);
  el.alert.textContent = '';
  setStatus('');
  updateDelivery();
  el.fields.disabled = !site.open;
  el.pending.hidden = el.thanks.hidden = el.confirmation.hidden = true;
  el.form.hidden = false;
  updateSubmit();
  el.formTitle.focus();
}

// ---------- Remembering the order (this browser only) ----------
// Storage can be missing or throw (private mode, blocked site data). Only the pending panel and the
// thank-you code depend on it, so failures are ignored.

/** { code, paymentUrl, count, kinds, delivery, total, at, paidClaimed }, or null. */
function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return /^[1-9][0-9]{5}$/.test(saved?.code) && Number.isFinite(saved.at) ? saved : null;
  } catch {
    return null;
  }
}

function storeOrder(order) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch { /* see above */ }
}
