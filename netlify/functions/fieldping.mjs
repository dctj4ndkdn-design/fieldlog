// ---------------------------------------------------------------------------
//  fieldping v3  —  TEMPORARY. DELETE AFTER USE.
//
//  v3 runs Jon's acceptance checks from 6 Oct and reports PASS / FAIL against
//  his exact expected numbers, plus the TYPE checks for his breaking change.
//
//  THE HARD STOP
//  `version.built` MUST read "2026-10-06 bigint-casts". Anything else means a
//  stale build is being hit and NOTHING BELOW IT MEANS ANYTHING. v3 says so
//  at the top, loudly, instead of letting a reader scroll past it.
//
//  THE BREAKING CHANGE, AND WHY IT GETS ITS OWN CHECK
//  customer_id and locations.id now arrive as STRINGS. A JS `===` against a
//  number silently returns false: no error, no empty state, just a lookup
//  that never matches. That is the exact failure shape this project keeps
//  getting bitten by, so the type is asserted rather than eyeballed.
//
//  WHAT IT STILL DOES NOT SHOW
//  No customer names, phone numbers, addresses or labels. Column names,
//  types, null counts and AGGREGATES only. The customer id used to test the
//  filtered calls is read from a response and used internally; it is never
//  printed. Do not "improve" this by adding a row dump.
// ---------------------------------------------------------------------------

const FIELD_API_URL =
  "https://mnqyaaylvrnlvdhtazlj.supabase.co/functions/v1/field-api";

const EXPECTED_BUILD = "2026-10-06 bigint-casts";

// Never report distinct VALUES for a column whose name suggests personal data,
// however few distinct values the sample happens to hold. Counts are fine.
const NEVER_ENUMERATE =
  /phone|mobile|fax|email|addr|street|unit|value|contact|name|label|note|city|zip|postal|lat|lon/i;

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const typeOf = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

function describeRows(rows) {
  if (!Array.isArray(rows)) return { note: "not an array", type: typeOf(rows) };
  if (rows.length === 0) return { returned: 0, columns: [] };

  const cols = new Map();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    for (const [k, v] of Object.entries(row)) {
      if (!cols.has(k)) cols.set(k, { types: new Set(), nulls: 0, seen: 0, counts: new Map(), tooMany: false });
      const c = cols.get(k);
      c.seen++;
      c.types.add(typeOf(v));
      if (v === null || v === undefined) c.nulls++;
      if (!c.tooMany) {
        const s = String(v);
        c.counts.set(s, (c.counts.get(s) || 0) + 1);
        if (c.counts.size > 12) { c.tooMany = true; c.counts.clear(); }
      }
    }
  }

  const out = [];
  for (const [name, c] of cols) {
    const col = {
      column: name,
      type: [...c.types].sort().join(" | "),
      present_in: c.seen + "/" + rows.length,
      nulls: c.nulls,
    };
    const longest = c.tooMany ? Infinity : [...c.counts.keys()].reduce((m, s) => Math.max(m, s.length), 0);
    if (!c.tooMany && c.counts.size <= 12 && longest <= 20 && !NEVER_ENUMERATE.test(name)) {
      col.value_counts = Object.fromEntries([...c.counts.entries()].sort((a, b) => b[1] - a[1]));
    }
    out.push(col);
  }
  return { returned: rows.length, columns: out };
}

// ---- aggregates. Numbers, never values. -----------------------------------
const distinct = (rows, key) =>
  new Set((rows || []).map((r) => (isPlainObject(r) ? String(r[key]) : null)).filter((v) => v !== null && v !== "undefined")).size;

const countWhere = (rows, key, val) =>
  (rows || []).filter((r) => isPlainObject(r) && r[key] === val).length;

// Does the name field carry Bryan's convention? A count, not a name. This is
// what decides whether a name-string join survives the migration.
function asteriskTally(rows, key) {
  let single = 0, double = 0, plain = 0, other = 0;
  for (const r of rows || []) {
    const v = isPlainObject(r) ? r[key] : null;
    if (typeof v !== "string") { other++; continue; }
    const t = v.trimEnd();
    if (t.endsWith("**")) double++;
    else if (t.endsWith("*")) single++;
    else if (v.includes("*")) other++;
    else plain++;
  }
  return { ends_with_single_asterisk: single, ends_with_double_asterisk: double, no_asterisk: plain, other };
}

// typeof the FIRST non-null value seen for a key, across rows.
function firstType(rows, key) {
  for (const r of rows || []) {
    if (isPlainObject(r) && r[key] !== null && r[key] !== undefined) return typeOf(r[key]);
  }
  return "absent-or-all-null";
}

async function call(secret, body) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(FIELD_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-field-secret": secret },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, stage: "network", error: String((err && err.message) || err), sent: body };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }

  const out = { action: body.action, ok: res.ok, http_status: res.status, ms, sent: body };
  if (!res.ok || json === null) {
    out.ok = false;
    out.error = (text || "").slice(0, 300);
    // Jon asked for the ref on a 500 — it matches a line in his function log.
    if (json && json.ref) out.ref = json.ref;
    return out;
  }

  out.envelope_keys = Object.keys(json).sort();
  for (const k of ["count", "capped", "searched"]) {
    if (typeof json[k] !== "undefined") out[k] = json[k];
  }

  // `version` carries an `actions` ARRAY, so a generic "find the array" would
  // treat the allow-list as data rows and throw the build stamp away. It is
  // configuration, not rows, and all of it is safe to show.
  if (body.action === "version") {
    out.value = json;
    return out;
  }

  const arrayKey = Object.keys(json).find((k) => Array.isArray(json[k]));
  if (arrayKey) {
    const rows = json[arrayKey];
    out.rows_key = arrayKey;
    out.shape = describeRows(rows);
    out.distinct_customer_id = distinct(rows, "customer_id");
    out.types = {
      customer_id: firstType(rows, "customer_id"),
      id: firstType(rows, "id"),
      latitude: firstType(rows, "latitude"),
      longitude: firstType(rows, "longitude"),
    };
    const nameCol = ["name", "customer_name"].find((c) =>
      (out.shape.columns || []).some((x) => x.column === c));
    if (nameCol) {
      out.name_column = nameCol;
      out.asterisk_tally = asteriskTally(rows, nameCol);
    }
    out._rows = rows; // stripped before the response is sent
  } else {
    out.value = json;
  }
  return out;
}

export default async (req) => {
  const secret = (process.env.FIELD_API_SECRET || "").trim();
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  if (!secret) {
    return new Response(JSON.stringify({
      ok: false,
      problem: "FIELD_API_SECRET is not set on this site, or the site has not been redeployed since it was set.",
      fix: "Netlify > Site configuration > Environment variables. Then Deploys > Trigger deploy > Deploy site.",
    }, null, 2), { status: 503, headers });
  }

  const results = [];
  const push = async (body) => { const r = await call(secret, body); results.push(r); return r; };

  // ---- 1. version first. Everything else is meaningless without it. ----
  const version = await push({ action: "version" });
  const built = version.ok && version.value ? version.value.built : null;
  const buildOk = built === EXPECTED_BUILD;
  const allowed = (version.ok && version.value && Array.isArray(version.value.actions))
    ? version.value.actions : [];
  const isFieldDog = allowed.includes("contacts");

  // ---- 2. the acceptance calls ----
  const contractors = await push({ action: "contractors" });
  await push({ action: "contractors", q: "con" });   // valid 2-60 char search

  const locations = await push({ action: "locations" });
  const contacts = await push({ action: "contacts" });

  // ---- 3. the calls the APPS will actually make: filtered by one customer.
  //         The id is read from a response and used internally. NEVER printed.
  let filterId = null;
  for (const src of [contacts, contractors]) {
    if (src && src.ok && Array.isArray(src._rows) && src._rows.length) {
      const v = src._rows[0].customer_id;
      if (v !== null && v !== undefined) { filterId = v; break; }
    }
  }
  if (filterId !== null) {
    const a = await push({ action: "contacts", customerId: filterId });
    const b = await push({ action: "locations", customerId: filterId });
    for (const r of [a, b]) {
      delete r.sent;            // the id lives in here
      r.sent_note = "customerId taken from a prior response; withheld on purpose";
    }
  }

  // ---- 4. PASS / FAIL against Jon's numbers ----
  const chk = (name, expected, actual) => ({
    check: name, expected, actual, PASS: JSON.stringify(expected) === JSON.stringify(actual),
  });

  const notPermitted = (r) =>
    !!r && !r.ok && r.http_status === 400 && /not permitted|unknown/i.test(r.error || "");

  const checks = [chk("version.built", EXPECTED_BUILD, built)];

  if (buildOk) {
    checks.push(chk("contractors count (no q)", 41, contractors.count));
    if (isFieldDog) {
      checks.push(
        chk("contacts count", 201, contacts.count),
        chk("contacts distinct customer_id", 80, contacts.distinct_customer_id),
        chk("contacts type=Email", 87, countWhere(contacts._rows, "type", "Email")),
        chk("contacts capped", false, contacts.capped),
        chk("locations count (hits the 500 cap)", 500, locations.count),
        chk("locations capped", true, locations.capped),
        chk("customer_id is a STRING", "string", contractors.types && contractors.types.customer_id),
        chk("locations.id is a STRING", "string", locations.types && locations.types.id),
        chk("latitude is a NUMBER", "number", locations.types && locations.types.latitude),
      );
    } else {
      checks.push(
        chk("locations refused for this secret", true, notPermitted(locations)),
        chk("contacts refused for this secret", true, notPermitted(contacts)),
        chk("customer_id is a STRING", "string", contractors.types && contractors.types.customer_id),
      );
    }
  }

  for (const r of results) delete r._rows;   // rows never leave this function

  const failed = checks.filter((c) => !c.PASS);
  const summary = {
    app: !version.ok ? "unknown" : isFieldDog ? "FIELD DOG" : "DRAW MANAGER",
    caller: version.ok && version.value ? version.value.caller : null,
    build_reported: built,
    build_expected: EXPECTED_BUILD,
    VERDICT: !buildOk
      ? "STOP. Stale build. version.built is '" + built + "', expected '" + EXPECTED_BUILD +
        "'. Nothing below this line is meaningful. Tell Jon."
      : failed.length === 0
        ? "ALL CHECKS PASS."
        : "FAIL on " + failed.length + " check(s): " + failed.map((c) => c.check).join(", "),
    checks_failed: failed.map((c) => c.check),
  };

  return new Response(JSON.stringify({ summary, checks, results }, null, 2), {
    status: 200, headers,
  });
};
