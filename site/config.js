// Public settings for the order page. This file is published with the site, so it holds public values only:
// the project URL and the publishable key are meant to be public (the database's rules do the protecting).
// Orders stay closed until supabaseUrl, supabasePublishableKey and a contact phone or email are set.
//
// Every value is a JavaScript string in '…'. A plain apostrophe inside one ends the string early and breaks the
// whole file, and the order page then stays closed. In Hebrew abbreviations use the geresh ׳ (U+05F3) and the
// gershayim ״ (U+05F4), as in 'רח׳ הרצל 5, ת״א', or put the value in backticks instead of '…'.
// Check this file before every push: npm run check (or npm start and open the page).
export const CONFIG = {
  supabaseUrl: 'https://rlqgmefjfebapkgvzsxa.supabase.co/rest/v1/',              // https://<ref>.supabase.co
  supabasePublishableKey: 'sb_publishable_z4qllbLPDwdc1QB69dqlPw_mSExnHyu',   // sb_publishable_… only. Never the secret key: app.js and npm run check refuse one, but once pushed it's public: rotate it (SETUP §16).
  contact: { phone: '', email: 'contact@figureit.co.il' }, // at least one is required before orders open
  business: { name: 'לי באלאן', id: 'ע״מ 205479413', address: 'כצנלסון 122, גבעתיים' }, // shown on terms.html and in the footer when set
  deliveryDays: '10',          // business days from the order until it's sent or ready for pickup, e.g. '10' or '7–10'
  pickupFrom: 'גבעתיים',       // where self-pickup is ('' leaves the place out of the form)

  // Prices in ₪: a plain number such as 160, no quotes. null hides it (and the totals that need it).
  prices: {
    one: 160,          // an order of a single figurine
    each: 150,         // each figurine in an order of 2 or more (null: the same as one)
    pickupPoint: 25,   // delivery to a pickup point; self-pickup is free
  },

  // The Grow payment page: the full link, starting with https://. Anything else counts as not set.
  growUrl: 'https://pay.grow.link/ODk4MzY~68267c6b7a5865d8622f76347cf65e80-NDE0OTU0OQ',
  // What the Grow page calls things, exactly as Grow shows them, so the confirmation can say what to choose there
  // (SETUP §7). A name left '' leaves its step out, and the confirmation still gives the total and the order number.
  growItems: { pet: 'פסלון של חיית מחמד', drawing: 'פסלון של ציור ילדים' }, // its product per kind
  growShipping: { pickup: 'איסוף עצמי', pickup_point: 'משלוח' },                       // its "משלוח" field's options
  growCoupon: 'FIGURE10',                                                               // the discount for 2 or more
};
