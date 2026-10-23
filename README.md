# Figure It order page

The page where customers order 3D-printed figurines from photos of their pets, or toys from their children's drawings.
It's in Hebrew, and it's plain HTML, CSS and JavaScript, published as it is on GitHub Pages at www.figureit.co.il.

A customer adds 1–10 figurines, each a pet or a drawing with 1–3 photos, chooses self-pickup or delivery to a pickup
point, fills in their details, and submits. The page saves the order to [Supabase](https://supabase.com) and uploads the
photos, shows a 6-digit order number and the total, and sends the customer to the [Grow](https://grow.business) payment
page, saying which items to choose there and where to type the number. Life2Print, the operator's app on their PC, picks
up the order; the operator confirms the payment and makes the models.

**Setting it up:** see [SETUP.md](SETUP.md): the Supabase project, the Grow page, `site/config.js`, GitHub Pages, the
domain and Life2Print.

## Layout

```
site/                 the published site (no build step)
  index.html          the order page
  terms.html          order terms and privacy notice (a template to fill in and have reviewed)
  styles.css          shared styles
  app.js              the form, photo preparation, saving the order, and the hand-off to Grow
  config.js           public settings: Supabase URL and publishable key, contact details, prices, the Grow page
  favicon.svg
  examples/           before-and-after photos for the examples section
supabase/schema.sql   the orders table, the photo bucket and their access rules (run in Supabase's SQL editor)
supabase/test.mjs     tests of schema.sql in PGlite, with no Supabase project
scripts/serve.mjs     local preview server
scripts/check.mjs     checks before a commit: no secret key, and the site's scripts load
.github/workflows/deploy.yml   publishes site/ on every push to main
```

## Local preview and tests

Requires Node.js 20 or later.

```sh
npm install
npm start          # http://localhost:8080/life2print-site/  (PORT to change)
npm test           # checks schema.sql's rules in PGlite
npm run check      # before every commit: no secret key in any file, and config.js and app.js load
```

The preview serves `site/` under `/life2print-site/`, the path GitHub Pages uses until the custom domain is connected,
so a link that only works at the site root breaks here too. With a filled-in `config.js`, orders placed in the preview
are real.

## Deploying

Run `npm run check`, commit, and push to `main`. The workflow refuses to publish if `site/` holds a Supabase secret key,
or if `app.js` or `config.js` doesn't load. It then stamps the asset links with the commit (GitHub Pages caches files for
10 minutes) and publishes `site/` to `https://<user>.github.io/life2print-site/`, which serves www.figureit.co.il once
the domain is connected (SETUP.md step 10).

The key check runs after the push, and this repository is public: a key it catches is already in the git history.
It keeps the key off the live site, but the key must still be rotated at once (SETUP.md step 16). `npm run check`
runs the same check before the commit, which is the one that prevents the leak.
