import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

// ------------------------------------------------------------------
//  FIELD DOG data endpoint  —  SECURED   (ACE Phase 0, §0.2 item 1)
//
//  Built from the repo version (which has the CDM upsert path) — NOT
//  from the older copies on OneDrive, which lack it.
//
//  THREE credentials, all set as environment variables in Netlify:
//
//    FD_OFFICE_CODE   office     read + write everything
//    FD_FIELD_CODE    field      read all but `unscheduled`;
//                                write entries/procurement/pto/extras
//    FD_PUSH_CODE     Draw Mgr   upsert into `projects` ONLY.
//                                Cannot read. Cannot touch anything else.
//
//  And one more, for the ServiceTitan lookup proxy added below:
//
//    FIELD_API_SECRET Field Dog's own field-api secret. NEVER sent to the
//                     browser. Marked "contains secret values" in Netlify,
//                     Production context, so it cannot be read back.
//
//  The browser sends the code as:   Authorization: Bearer <code>
//
//  FAILS CLOSED. If a variable is unset, too short, or two are equal,
//  every request is refused. There is no default code and no fallback —
//  a missing variable must never mean "allow".
//
//  WHAT THIS REPLACED: no authentication at all. GET returned all nine
//  collections to anyone with the URL; POST overwrote any collection;
//  Access-Control-Allow-Origin was "*", so any website could call it
//  out of a visitor's browser. OFFICE_PIN in index.html was a UI
//  curtain that this endpoint never checked.
//
//  KNOWN RESIDUAL RISK (accepted 2026-08-14, Bryan): normal app saves
//  overwrite a whole collection, so a field code used OUTSIDE the app
//  can rewrite the four field collections wholesale — e.g. approve its
//  own PTO row. That is an insider holding a valid credential, not an
//  anonymous stranger. The fix is to make field writes merge-by-id like
//  the upsert path below. Deferred; see the ACE parking lot.
// ------------------------------------------------------------------

const ALL_COLLECTIONS = [
  "projects", "contractors", "entries", "employees",
  "procurement", "pto", "extras", "assignments", "unscheduled",
];

// Field crews read what the field UI actually displays. `unscheduled` is
// the office-only scheduling backlog and is never passed to FieldSide.
const FIELD_READ = ALL_COLLECTIONS.filter((c) => c !== "unscheduled");

// Field crews write only the four collections the field UI owns. This
// mirrors exactly the save props FieldSide receives in index.html:
// saveEntries, saveProcurement, savePto, saveExtras.
const FIELD_WRITE = ["entries", "procurement", "pto", "extras"];

const PERMS = {
  office: { read: ALL_COLLECTIONS, write: ALL_COLLECTIONS, upsert: ALL_COLLECTIONS, lookup: true },
  field:  { read: FIELD_READ,      write: FIELD_WRITE,      upsert: FIELD_WRITE,     lookup: true },
  // The Draw Manager job push. Write-only, one collection, upsert only.
  // 🛑 NO LOOKUP. This credential exists so another APP can push a job header
  // in. It is not a person, it has no screen, and nothing it does needs a
  // customer's phone number. Least privilege, same as its empty read list.
  push:   { read: [],              write: [],               upsert: ["projects"], lookup: false },
};

// ---- Jon's read-only edge function -----------------------------------------
// Field Dog's secret IS granted contacts, locations and contractors. The
// allow-list below is therefore not the security boundary -- the database GRANT
// is -- but it pins what the BROWSER may ask for, so a future change at Jon's
// end cannot silently widen what this page can request.
const FIELD_API_URL =
  "https://mnqyaaylvrnlvdhtazlj.supabase.co/functions/v1/field-api";
const FIELD_API_ALLOWED = ["contacts", "locations", "contractors", "version"];

// No rate limiting is possible in a stateless function, so code LENGTH is
// the only defence against guessing. Six digits (the old PIN's shape) is
// a million tries — refuse it.
const MIN_CODE_LENGTH = 10;

const env = (name) => (process.env[name] || "").trim();

// ---- CORS -----------------------------------------------------------
// The app itself is same-origin and needs no CORS. The ONLY cross-origin
// caller is the Construction Draw Manager's "Send to Field Dog" button.
// Allow that one origin, echoed back explicitly — never "*", which is
// permission for every website on the internet.
const allowedOrigins = () =>
  env("FD_PUSH_ORIGIN").split(",").map((o) => o.trim()).filter(Boolean);

function corsFor(req) {
  const origin = req.headers.get("origin") || "";
  if (!origin) return {};
  if (!allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

const baseHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Vary": "Origin, Authorization",
};

const reply = (req, status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders, ...corsFor(req) },
  });

// Constant-time compare that tolerates different lengths, so response
// time doesn't leak how much of a guess was right.
const sameSecret = (a, b) =>
  timingSafeEqual(
    createHash("sha256").update(String(a)).digest(),
    createHash("sha256").update(String(b)).digest(),
  );

function tierFor(req) {
  const office = env("FD_OFFICE_CODE");
  const field  = env("FD_FIELD_CODE");
  const push   = env("FD_PUSH_CODE");

  // --- Refuse to run misconfigured, rather than run insecurely. ---
  if (!office || !field || !push) return "unconfigured";
  if ([office, field, push].some((c) => c.length < MIN_CODE_LENGTH)) return "tooshort";
  if (sameSecret(office, field) || sameSecret(office, push) || sameSecret(field, push))
    return "duplicate";

  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  const code = m ? m[1].trim() : "";
  if (!code) return null;

  // Least privilege first, so a configuration slip can never promote.
  if (sameSecret(code, push))   return "push";
  if (sameSecret(code, field))  return "field";
  if (sameSecret(code, office)) return "office";
  return null;
}

export default async (req) => {
  const tier = tierFor(req);

  // Preflight is answered before auth (the browser sends no Authorization
  // header on a preflight), but only for an allow-listed origin.
  // Status 200 with an empty body, NOT 204 — matching the repo version.
  // `new Response("", {status: 204})` throws at runtime ("Invalid response
  // status code 204"), because 204 must have a null body. The older copies
  // of this file on OneDrive have that bug; the deployed repo version does
  // not. Do not "tidy" this back to 204.
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 200,
      headers: { ...baseHeaders, ...corsFor(req) },
    });
  }

  if (tier === "unconfigured" || tier === "tooshort" || tier === "duplicate") {
    // Log the real reason for whoever is deploying; tell the caller nothing.
    console.error(
      "field dog: refusing all requests — misconfigured (" + tier + "). " +
      "FD_OFFICE_CODE / FD_FIELD_CODE / FD_PUSH_CODE must all be set, " +
      "at least " + MIN_CODE_LENGTH + " characters, and different from each other."
    );
    return reply(req, 503, { error: "temporarily unavailable" });
  }
  if (!tier) return reply(req, 401, { error: "unauthorized" });

  const perms = PERMS[tier];

  try {
    // getStore MUST be called inside the handler (Netlify requirement)
    const store = getStore({ name: "fieldlog", consistency: "strong" });

    // ---- READ: only the collections this code may see ----
    if (req.method === "GET") {
      if (!perms.read.length) return reply(req, 403, { error: "this code cannot read" });
      const out = { tier };
      for (const c of perms.read) {
        out[c] = (await store.get(c, { type: "json" })) || [];
      }
      return reply(req, 200, out);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);

      // ---- ServiceTitan lookup, proxied so the secret stays server-side ----
      //
      //  This page is served to anyone with the URL, so a secret in it would be
      //  published. The browser asks this function; this function calls
      //  field-api. Same shape as the Draw Manager's proxy.
      if (body && body.action === "field-api") {
        if (!perms.lookup) return reply(req, 403, { error: "this code cannot look up customers" });

        const secret = env("FIELD_API_SECRET");
        if (!secret) {
          console.error("field dog: FIELD_API_SECRET is not set; the lookup proxy is disabled.");
          return reply(req, 503, { error: "customer lookup is not configured on the server" });
        }

        const call = body.call && typeof body.call === "object" ? body.call : {};
        if (!FIELD_API_ALLOWED.includes(call.action)) {
          return reply(req, 400, { error: "that lookup is not available" });
        }

        // Only forward the arguments each action actually takes. Passing the
        // body through wholesale would let the browser set anything field-api
        // ever learns to accept, including things added after this was written.
        const out = { action: call.action };
        const num = (v, max) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : null;
        };
        if (call.action === "contractors") {
          if (call.q !== undefined && call.q !== null && String(call.q) !== "") {
            const q = String(call.q).trim();
            if (q.length < 2 || q.length > 60) {
              return reply(req, 400, { error: "Type at least 2 characters to search." });
            }
            out.q = q;
          }
          const n = num(call.limit, 500); if (n) out.limit = n;
        } else if (call.action === "contacts") {
          if (call.customerId !== undefined && call.customerId !== null) out.customerId = String(call.customerId);
          const n = num(call.limit, 500); if (n) out.limit = n;
        } else if (call.action === "locations") {
          if (call.customerId !== undefined && call.customerId !== null) out.customerId = String(call.customerId);
          if (typeof call.activeOnly === "boolean") out.activeOnly = call.activeOnly;
          if (call.afterId !== undefined && call.afterId !== null) out.afterId = String(call.afterId);
          if (typeof call.since === "string" && call.since) out.since = call.since;
          const n = num(call.limit, 500); if (n) out.limit = n;
        }

        let r, j = null, text = "";
        try {
          r = await fetch(FIELD_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-field-secret": secret },
            body: JSON.stringify(out),
          });
          text = await r.text();
          try { j = JSON.parse(text); } catch {}
        } catch (err) {
          console.error("field dog: could not reach field-api:", err);
          return reply(req, 502, { error: "could not reach ServiceTitan" });
        }

        if (!r.ok || j === null) {
          // field-api returns a `ref` on a 500 that matches a line in Jon's
          // function log. Pass it through; it is the difference between "it
          // broke" and him reading the real error in seconds.
          const ref = j && j.ref ? j.ref : null;
          console.error("field dog: field-api HTTP " + r.status + (ref ? " ref=" + ref : "") + " for " + out.action);
          return reply(req, 502, {
            error: (j && j.error) || ("ServiceTitan lookup returned HTTP " + r.status),
            ref,
            status: r.status,
          });
        }

        return reply(req, 200, { ok: true, result: j });
      }

      const { collection, data, upsert } = body || {};

      if (!ALL_COLLECTIONS.includes(collection)) {
        return reply(req, 400, { error: "unknown collection" });
      }

      // ---- UPSERT one record by id (Draw Manager → Field Dog job push) ----
      // Merges a single record into the array; never overwrites the whole
      // collection, and preserves fields the record doesn't include.
      // UNCHANGED from the repo version except for the permission check.
      if (upsert && typeof upsert === "object" && !Array.isArray(upsert)) {
        if (!perms.upsert.includes(collection)) {
          return reply(req, 403, { error: "not permitted" });
        }
        if (!upsert.id) {
          return reply(req, 400, { error: "upsert needs an id" });
        }
        const current = (await store.get(collection, { type: "json" })) || [];
        const arr = Array.isArray(current) ? current : [];
        const idx = arr.findIndex((r) => r && r.id === upsert.id);
        const prev = idx >= 0 ? arr[idx] : null;

        // Pull bids out so we can reconcile them per-trade (preserving
        // history) instead of blindly overwriting the whole bids object.
        const { bids: incomingBids, ...rest } = upsert;
        const merged = prev ? { ...prev, ...rest } : { ...rest };

        if (incomingBids && typeof incomingBids === "object") {
          const prevBids = (prev && prev.bids) || {};
          const outBids = { ...prevBids };
          const ts = new Date().toISOString();
          for (const trade of Object.keys(incomingBids)) {
            const newText = ((incomingBids[trade] || {}).current || "").trim();
            if (!newText) continue; // don't seed/clobber with an empty note
            const old = prevBids[trade] || { current: "", history: [] };
            const oldText = (old.current || "").trim();
            if (newText === oldText) { outBids[trade] = old; continue; }
            const history = Array.isArray(old.history) ? old.history.slice() : [];
            if (oldText) {
              history.unshift({
                id: "h_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
                text: old.current,
                by: "CDM",
                ts,
              });
            }
            outBids[trade] = {
              current: (incomingBids[trade] || {}).current,
              history: history.slice(0, 20),
            };
          }
          merged.bids = outBids;
        } else if (prev && prev.bids) {
          merged.bids = prev.bids;
        }

        if (idx >= 0) arr[idx] = merged;
        else arr.push(merged);
        await store.setJSON(collection, arr);
        return reply(req, 200, { ok: true, mode: "upsert", added: idx < 0 });
      }

      // ---- Overwrite one whole collection (normal app save) ----
      if (!perms.write.includes(collection)) {
        return reply(req, 403, { error: "this code is not permitted to change " + collection });
      }
      if (!Array.isArray(data)) {
        return reply(req, 400, { error: "data must be an array" });
      }
      await store.setJSON(collection, data);
      return reply(req, 200, { ok: true, tier });
    }

    return reply(req, 405, { error: "method not allowed" });
  } catch (err) {
    // Log the detail to the Netlify function log; don't hand it to the caller.
    console.error("field dog data error:", err);
    return reply(req, 500, { error: "server error" });
  }
};

export const config = { path: "/api/data" };
