import { getStore } from "@netlify/blobs";

// ------------------------------------------------------------------
//  FIELDLOG data endpoint
//  All app data lives in three "collections" inside one Blobs store:
//    projects | contractors | entries
//  The browser never touches Blobs directly — it goes through here.
// ------------------------------------------------------------------

const COLLECTIONS = ["projects", "contractors", "entries", "employees", "procurement", "pto"];

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

export default async (req) => {
  // getStore MUST be called inside the handler (Netlify requirement)
  const store = getStore({ name: "fieldlog", consistency: "strong" });

  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  try {
    // ---- READ: return everything the app needs in one shot ----
    if (req.method === "GET") {
      const out = {};
      for (const c of COLLECTIONS) {
        out[c] = (await store.get(c, { type: "json" })) || [];
      }
      return new Response(JSON.stringify(out), { status: 200, headers });
    }

    // ---- WRITE: overwrite one collection with the array sent ----
    if (req.method === "POST") {
      const body = await req.json();
      const { collection, data } = body || {};

      if (!COLLECTIONS.includes(collection)) {
        return new Response(
          JSON.stringify({ error: "unknown collection" }),
          { status: 400, headers }
        );
      }
      if (!Array.isArray(data)) {
        return new Response(
          JSON.stringify({ error: "data must be an array" }),
          { status: 400, headers }
        );
      }

      await store.setJSON(collection, data);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err && err.message ? err.message : err) }),
      { status: 500, headers }
    );
  }
};

export const config = { path: "/api/data" };
