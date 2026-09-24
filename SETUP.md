# Heavenly View Wishlist — setup notes

A group gift wishlist site for family & friends: people sign in with their
name, join or create a "group" (e.g. a family), and add items to their own
wishlist that other group members can see (but not their own -- no
spoiling surprises). Group members can mark someone else's item as
already bought, and everyone but the person who wanted it can see that --
so the surprise stays a surprise right up until it's opened.

## How the pieces fit together

- **`index.html` / `style.css` / `app.js` / `config.js`** — the whole
  front end. It's plain HTML/CSS/JS (no build step, no framework), hosted
  as a static site.
- **`supabase-schema.sql`** — the database schema (tables + row-level
  security policies + a couple of helper functions). Run once, in
  Supabase's SQL Editor, against a new project.
- **`config.js`** — holds the Supabase project's public URL and
  publishable key. Safe to be public in the repo (see the comments in the
  file) since real access control is enforced by the row-level security
  policies in `supabase-schema.sql`, not by keeping this key secret.
- **`api/scrape.js`** — a small serverless function that fetches a
  product link's photo/description for the "Add item" form. Can't run on
  GitHub Pages (it only serves static files) — needs **Vercel**, which is
  why the site is deployed there too.
- **`api/delete-account.js`** — a small serverless function that deletes
  an account when someone uses "Delete account" in Settings. Needs
  Vercel for the same reason, and needs its own environment variable
  (see the Vercel setup section below).
- **`assets/logo.png`** — a spare logo/photo asset. Not currently
  referenced by the site (the header logo mark is drawn as inline SVG),
  kept here for future use.

## Where things are hosted

- **GitHub repo:** `WishList-Code/Wishlist`
- **Static site (GitHub Pages):** `https://wishlist-code.github.io/Wishlist/`
  — good for quickly checking the UI, but the link-preview scraper and
  account deletion won't work here (no serverless functions).
- **Full site with working API routes (Vercel):** `https://wishlist-wine-kappa.vercel.app`
  — this is the one to actually use day-to-day, since it's the only place
  `/api/scrape` and `/api/delete-account` work. Connected to the same
  GitHub repo, so every push to `main` auto-deploys here too.
- **Database (Supabase):** project "Heavenly View Wishlist", org "Star
  INC.", project ref `fobobmhfuevqdgvvyxxm`.

## Supabase setup (already done once, kept here for reference)

1. Create a Supabase project.
2. Open **SQL Editor → New query**, paste in the contents of
   `supabase-schema.sql`, and run it. This creates four tables
   (`profiles`, `groups`, `group_members`, `wishlist_items`) with row-level
   security policies, a trigger that auto-creates a `profiles` row
   (with first/last name) whenever someone signs up, a view
   (`wishlist_items_view`) that hides purchase status from an item's own
   owner, and four helper functions used for marking items bought and for
   the owner-assisted "add by name" joining flow (see "Feature notes"
   below).
3. Open **Project Settings → Data API** for the Project URL, and
   **Project Settings → API Keys** for the publishable (formerly "anon
   public") key. Put both into `config.js`:
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR-PUBLISHABLE-KEY";
   ```
4. Email confirmation on sign-up is turned **off** for this project
   (Authentication → Providers → Email), so people get in immediately
   after creating an account rather than having to confirm their email
   first — this suits a small family app better.

## Vercel setup (already done once, kept here for reference)

The `api/` folder only runs on Vercel, not on GitHub Pages.

1. In Vercel, "Add New Project" and import the `WishList-Code/Wishlist`
   GitHub repo.
2. No build settings are needed — it's a static site with serverless
   functions, so the defaults work (Framework Preset "Other", no build
   command).
3. Add an environment variable for account deletion:
   - **Name:** `SUPABASE_SERVICE_ROLE_KEY`
   - **Value:** the project's **service_role** secret key, from
     Supabase's **Project Settings → API Keys** (a different key from
     the publishable one in `config.js` — this one must never be public,
     which is exactly why it lives here as a Vercel env var instead of
     in the repo).
   - This is what lets `api/delete-account.js` actually delete an
     account: deleting your own Supabase account isn't something the
     browser can do with just the publishable key. Until this is set,
     the "Delete account" button in Settings will show an error instead
     of deleting anything — nothing else is affected.
4. Deploy. Every push to `main` auto-redeploys.
5. To sanity-check the deploy, POST to `/api/scrape` with
   `{"url": "https://example.com"}` — it shouldn't 404, and should come
   back with at least a `title`.

## Feature notes

- **Named accounts.** Sign-up collects a first and last name alongside
  email/password (stored in `profiles.first_name` / `profiles.last_name`
  via the sign-up trigger). Everyone is shown by their real name
  everywhere in the app instead of "You", unless they've set a nickname
  for themselves in a particular group (Settings, inside that group).
- **Opening a group shows people, not items.** Tapping a group card lands
  on an alphabetical list of its members first. Tapping a person then
  shows that person's wishlist. This replaced the old behavior of landing
  straight on your own wishlist.
- **Marking items as bought, hidden from the person it's for.** Any group
  member other than the item's own owner can mark it "bought" from that
  person's wishlist view. Everyone else in the group then sees it's
  bought (and who bought it) — except the person who wanted it, who sees
  their own wishlist exactly as before, with no hint anything changed.
  This is enforced on the database side, not just in the app's UI: reads
  go through a view (`wishlist_items_view`) that always nulls out the
  purchase fields for the item's own owner, no matter how the data is
  queried. Only the person who marked an item bought can undo it
  (`unmark_item_purchased`) — nobody else in the group can un-mark
  someone else's purchase.
- **Two ways to join a group.** The original way still works: share the
  group's invite code, and whoever has it can join themselves. New: a
  group's owner (whoever created it) can instead search for someone by
  name and add them directly, without needing to hand out the invite
  code at all. The search covers everyone with an account, not just
  people already in one of the owner's groups (you have to be able to
  find someone *before* they share a group with you), but only the
  actual owner of a given group can add someone to it this way.
- **Cleaner phone layout: everything account-related lives behind the
  hamburger.** The header used to show your name and a "Log out" button
  directly, next to a separate fixed hamburger icon pinned to the top of
  the screen. Now the hamburger sits inline in the header itself (in the
  spot the name used to be), which also removes the empty reserved space
  that used to sit above the page for that fixed icon. Opening the menu
  shows your name, and "⚙️ Settings" from there has your account
  controls: log out, leave a group (when you're in one), and delete your
  account.
- **Delete account, with a two-step confirmation.** In Settings, "Delete
  account" first asks you to confirm ("Yes, delete my account") before
  anything happens — there's no way to delete an account with a single
  tap. Deleting cascades through the database on its own: your wishlist
  items and your membership in every group go with it. Any group you
  created stays for its other members (see "Known gaps" below for what
  that means for "add by name" in that group). Needs the
  `SUPABASE_SERVICE_ROLE_KEY` environment variable above to work at all.
- **Everyone has to have a name on file.** Right after signing in, an
  account missing a first/last name (an older account from before named
  accounts existed, or one a group owner added by name, which doesn't
  collect a password or a name for the person being added) is asked to
  fill that in before it can do anything else. This is a one-time,
  one-screen check on sign-in, not tied to any particular feature, so
  the same gate would catch any future required field the same way.

## Known gaps / things to revisit

- **`assets/logo-full.jpg`** — not currently added (no wordmark version of
  the logo exists yet); nothing in the site references it, so this is
  safe to leave out.
- Email/password is the only sign-in method right now (no magic links, no
  social sign-in) — intentional, to keep the first version simple.
- If the owner of a group deletes their own account, that group's
  `created_by` clears (the group and its other members are unaffected),
  but nobody can use "add by name" for that group anymore, since that
  only ever worked for whoever the current owner is. The invite code
  still works for that group either way.
- If someone deletes their account after marking someone else's item as
  bought, the item stays marked bought (so nobody accidentally buys a
  duplicate) but no longer shows whose name bought it.
