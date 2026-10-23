// Checks to run before every commit: npm run check.
//
// 1. No Supabase secret key in anything a commit would publish. deploy.yml runs the same three rules, but only after the
//    push, when the key is already public in this repository's history. Here they run before the commit, and on every
//    file `git add -A` would stage, not only site/.
// 2. site/app.js and site/config.js parse, and config.js exports CONFIG. If either fails to load, the page shows only
//    "orders will open soon" (index.html is closed until app.js opens it), and nobody can order. The usual cause is a
//    Hebrew abbreviation typed with an ASCII apostrophe or quote inside a '…' string: 'רח' הרצל'.
// 3. Warnings for config values that app.js would ignore as if unset: a Grow link without https://, a price in quotes,
//    and Grow names given for only one of two kinds or shipping options.
//
// Only file names are printed for rule 1, like deploy.yml. No dependencies: it runs before `npm install`.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_FILE = 'site/config.js';
const APP_FILE = 'site/app.js';

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FAIL  ${message}`);
};
let warned = false;
const warn = (message) => {
  warned = true;
  console.warn(`warn  ${message}`);
};

// The files a commit would publish: tracked plus untracked-but-not-ignored, as `git add -A` sees them.
// Without git (or outside a repo), fall back to site/.
function filesToCheck() {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status === 0) return git.stdout.split('\0').filter((file) => file && fs.existsSync(path.join(ROOT, file)));
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
  return walk('site');
}

// ---------- 1. Secret keys (deploy.yml's rules) ----------

// Rule 1: config.js must not even mention them, so a key can't hide in a comment either.
if (/sb_secret_|service_role/.test(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8'))) {
  fail(`${CONFIG_FILE} mentions sb_secret_ or service_role. Only the sb_publishable_ key belongs there; reword any comment that names them.`);
}
for (const file of filesToCheck()) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  // Rule 2: a new-style secret key anywhere.
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) fail(`${file} holds what looks like a Supabase secret key (sb_secret_...).`);
  // Rule 3: a legacy JWT whose role is service_role; the word only shows once the payload is decoded.
  for (const [jwt] of text.matchAll(/eyJ[A-Za-z0-9_-]+[.]eyJ[A-Za-z0-9_-]+/g)) {
    if (Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8').includes('"service_role"')) {
      fail(`${file} holds a Supabase JWT whose role is service_role (the legacy secret key).`);
      break;
    }
  }
}
if (failed) {
  console.error('\nTake the key out before committing. If it was ever pushed, it is public: rotate it (SETUP.md step 16).');
  // Stop here: the syntax checks below print source lines, which could include the key.
  process.exit(1);
}

// ---------- 2. The site's scripts load ----------

// node --check prints the file, line and a caret under the mistake, which an import error doesn't.
for (const file of [APP_FILE, CONFIG_FILE]) {
  const run = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (run.status !== 0) {
    const where = run.stderr.split('\n').filter((line) => !/^\s+at |^Node[.]js v/.test(line)).join('\n').trim();
    fail(`${file} doesn't parse:\n${where}`);
    if (file === CONFIG_FILE) {
      console.error("      Hebrew abbreviations inside '…': use the geresh ׳ and gershayim ״ (רח׳, ת״א), or wrap the value in `backticks`.");
    }
  }
}

let config;
if (!failed) {
  try {
    ({ CONFIG: config } = await import(pathToFileURL(path.join(ROOT, CONFIG_FILE)).href));
    if (!config || typeof config !== 'object') fail(`${CONFIG_FILE} must export CONFIG (export const CONFIG = { … }).`);
  } catch (error) {
    fail(`${CONFIG_FILE} doesn't load: ${error.message}`);
  }
}

// ---------- 3. Config values app.js would ignore ----------

if (config && typeof config === 'object') {
  const httpsLink = (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  };
  if (config.supabaseUrl && !httpsLink(config.supabaseUrl)) {
    warn('supabaseUrl should be the project URL, https://<ref>.supabase.co. Orders stay closed until it is.');
  }
  for (const key of ['figurine', 'pickupPoint']) {
    const price = config.prices?.[key] ?? null;
    if (price !== null && !(Number.isFinite(price) && price >= 0 && price < 100_000)) {
      warn(`prices.${key} must be a plain number such as 160, without quotes, or null. The page treats it as not set.`);
    }
  }
  if (config.growUrl && !httpsLink(config.growUrl)) {
    warn('growUrl must be the full link starting with https:// (https://pay.grow.link/…). '
      + 'Until it is, the confirmation shows no Grow button and says you\'ll be in touch about payment.');
  }
  // The confirmation names the Grow products to choose only when it knows the product for every kind in the order.
  const kinds = ['pet', 'drawing'].filter((key) => config.growItems?.[key]?.trim?.());
  if (kinds.length === 1) {
    warn('growItems names the Grow product for only one kind of figurine. The confirmation then says which products to '
      + 'choose only for orders of that kind.');
  }
  const shipping = ['pickup', 'pickup_point'].filter((key) => config.growShipping?.[key]?.trim?.());
  if (shipping.length === 1) warn('growShipping names only one of the Grow page\'s two shipping options.');
}

if (failed) process.exit(1);
console.log(warned ? 'All checks passed, but see the warnings above.' : 'All checks passed.');
