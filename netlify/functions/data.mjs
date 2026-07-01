import { getStore } from "@netlify/blobs";

// ------------------------------------------------------------------
//  FIELDLOG data endpoint
//  All app data lives in collections inside one Blobs store:
//    projects | contractors | entries | employees
//  The browser never touches Blobs directly — it goes through here.
// ------------------------------------------------------------------

const COLLECTIONS = ["projects", "contractors", "entries", "employees", "procurement", "pto", "extras", "assignments", "unscheduled"];

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  // Answer the CORS preflight FIRST — before touching the store.
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers });
  }

  const store = getStore({ name: "fieldlog", consistency: "strong" });

  try {
    // ---- READ: return everything the app needs in one shot ----
    if (req.method === "GET") {
      const out = {};
      for (const c of COLLECTIONS) {
        out[c] = (await store.get(c, { type: "json" })) || [];
      }
      return new Response(JSON.stringify(out), { status: 200, headers });
    }

    // ---- WRITE ----
    if (req.method === "POST") {
      const body = await req.json();
      const { collection, data, upsert } = body || {};

      if (!COLLECTIONS.includes(collection)) {
        return new Response(
          JSON.stringify({ error: "unknown collection" }),
          { status: 400, headers }
        );
      }

      // ---- UPSERT one record by id (CDM → Field Dog job push) ----
      // Merges a single record into the array; never overwrites the whole
      // collection, and preserves fields the record doesn't include.
      if (upsert && typeof upsert === "object" && !Array.isArray(upsert)) {
        if (!upsert.id) {
          return new Response(
            JSON.stringify({ error: "upsert needs an id" }),
            { status: 400, headers }
          );
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
        return new Response(
          JSON.stringify({ ok: true, mode: "upsert", added: idx < 0 }),
          { status: 200, headers }
        );
      }

      // ---- Overwrite one whole collection (normal app save) ----
      if (!Array.isArray(data)) {
        return new Response(
          JSON.stringify({ error: "data must be an array" }),
          { status: 400, headers }
        );
      }
      await store.setJSON(collection, data);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(
      JSON.stringify({ error: "method not allowed" }),
      { status: 405, headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err && err.message ? err.message : err) }),
      { status: 500, headers }
    );
  }
};

