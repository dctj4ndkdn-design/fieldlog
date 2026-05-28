# FieldLog — setup guide

A job-tracking web app for your field crews + office. It runs as a website on
Netlify and saves everything to one shared place (Netlify Blobs), so what the
guys enter in the field shows up in the office reports automatically.

The guys "install" it by opening the link once and tapping **Add to Home
Screen** — it then opens full-screen with its own icon, just like an app.

---

## What's in this folder

```
fieldlog/
├─ netlify.toml                 ← tells Netlify how to run things (don't edit)
├─ package.json                 ← lists the one dependency it needs
├─ public/
│  ├─ index.html                ← THE APP (this is where all features live)
│  ├─ manifest.webmanifest      ← makes "Add to Home Screen" look like an app
│  ├─ icon-192.png / icon-512.png ← the home-screen icon
└─ netlify/
   └─ functions/
      └─ data.mjs               ← the little server piece that saves/loads data
```

---

## Getting it live (about 5 minutes, no command line needed)

### Option A — drag-and-drop (easiest, but no data store)
Netlify's drag-and-drop deploy does NOT run the data function, so use Option B
below for the real thing. Drag-and-drop is fine only for a quick look.

### Option B — connect a Git repo (recommended, gives you the shared data)
1. Make a free account at **github.com** if you don't have one.
2. Create a new repository (call it `fieldlog`), and upload everything in this
   folder into it. (GitHub's website has an "upload files" button — you can drag
   the whole folder contents in.)
3. Go to **app.netlify.com → Add new site → Import an existing project**.
4. Pick GitHub, choose your `fieldlog` repo.
5. Netlify reads `netlify.toml` automatically — just click **Deploy**.
6. When it finishes you get a URL like `https://something-random.netlify.app`.
   You can rename it under **Site configuration → Change site name**.

That's it. The data store (Netlify Blobs) turns itself on the first time the app
saves something — there is nothing to set up, no database to create.

---

## Putting it on a phone

1. Open the Netlify URL in **Safari (iPhone)** or **Chrome (Android)**.
2. iPhone: tap the **Share** icon → **Add to Home Screen**.
   Android: tap the **⋮** menu → **Add to Home screen / Install app**.
3. It now sits on the home screen with the FieldLog icon and opens full-screen.

Share the same URL with every tech — they all read and write the same data.

---

## The office PIN

Default PIN is **1234**.

To change it: open `public/index.html`, find this line near the top of the
script (search for `OFFICE_PIN`):

```js
const OFFICE_PIN = "1234";
```

Change `1234` to whatever you want, save, and push the change to GitHub —
Netlify redeploys automatically in under a minute.

> Note: this PIN is a simple gate to keep field guys out of the office screens.
> It is not heavy-duty security. Anyone with the link could in theory dig it out.
> When you're ready for real logins, that's the next upgrade.

---

## Changing things later (the "on the fly" workflow)

Almost everything you'll want to tweak lives in **`public/index.html`**:

- **Checklist items** — search for `CHECKLISTS`. Each trade is a list of
  sections, and each section has its items. To add an item, add a line to a
  section's list. To make an item also capture Model # and Serial #, write it as
  `{ label: "Item name", equipment: true }` instead of a plain `"Item name"`.
  The Plumbing checklist is your real sheet (DWV, Waterlines, Gas Line, Finish).
  HVAC and In-Floor are placeholder starter lists — replace them when ready.
- **Types of work** — search for `WORK_TYPES`.
- **Employees** — managed in the app: Office → Employees. No code editing needed.
- **Office PIN** — search for `OFFICE_PIN` (see above).

After any edit: save the file, upload/commit it to GitHub, and Netlify
redeploys on its own. No database migrations, no extra steps.

---

## How the data is stored

- All data lives in your site's **Netlify Blobs** store named `fieldlog`,
  in three buckets: `projects`, `contractors`, `entries`.
- The app never touches the store directly — it calls `/api/data`
  (that's the `data.mjs` function), which is the only thing allowed to
  read/write. This keeps it working safely from every phone.
- Notes are append-only by design: once saved they're never edited or deleted;
  addenda get added alongside the original. (This is enforced in the app's
  behavior — the data function itself just stores what it's given.)

---

## Things to know / current limits

- **Backups:** there's no automatic export yet. A "download all data" button for
  the office is a good next addition.
- **Offline:** the home-screen app needs a connection to load and save (it's
  reading/writing the shared store). Full offline support is a later upgrade.
- **PIN security:** see the note above — fine for now, not bank-grade.

Bring me the next changes whenever the crews ask for them.
