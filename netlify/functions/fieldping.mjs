// ---------------------------------------------------------------------------
//  fieldping.mjs  —  TEMPORARY. DELETE AFTER USE.
//
//  WHAT IT IS FOR
//  Nobody has ever seen a real response from Jon's `field-api`. The ledger
//  (§3.21) records the ACTION NAMES and the envelope `{count, capped, ...}`
//  but NOT the column names inside each row. Writing the real feature now
//  would mean guessing key names, and a guessed key name produces a
//  confident zero that looks like working code (§7.9).
//
//  So this asks field-api what shape its data is, and reports the SHAPE ONLY.
//
//  WHAT IT DELIBERATELY DOES NOT DO
//  It NEVER returns customer names, phone numbers, addresses or any other
//  row value. It returns column names, data types, null counts, and — only
//  for columns that behave like a fixed enumeration — the distinct values.
//  That is why it needs no password: there is nothing in the output worth
//  stealing. Do not "improve" it by adding a row dump.
//
//  The secret is read from the environment and is never echoed back, not
//  even partially, not even its length.
//
//  IT ALSO TESTS THE SECURITY BOUNDARY
//  It tries all four actions. On the Draw Manager's site, `contacts` MUST
//  come back refused — Jon granted that role no access to the contacts
//  view. A success there is a finding, not a convenience.
// ---------------------------------------------------------------------------

const FIELD_API_URL =
  "https://mnqyaaylvrnlvdhtazlj.supabase.co/functions/v1/field-api";

const ACTIONS = ["version", "contractors", "locations", "contacts"];

// Rows pulled per action purely to work out the shape. Enough that a real
// enumeration (4 contact types) is distinguishable from free text.
const SAMPLE = 25;

// Never report distinct values for a column whose NAME suggests personal
// data, however few distinct values the sample happens to contain.
const NEVER_ENUMERATE = /phone|mobile|fax|email|addr|street|contact|name|label|note|city|zip|postal/i;

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// Build a shape report from a list of row objects. Values never leave here
// except as distinct sets for columns that pass BOTH the name test and the
// low-cardinality test.
function describeRows(rows) {
  if (!Array.isArray(rows)) return { note: "not an array", type: typeOf(rows) };
  if (rows.length === 0) return { sampled: 0, columns: [] };

  const columns = new Map(); // name -> {types:Set, nulls:n, seen:n, values:Set, tooMany:bool}

  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    for (const [k, v] of Object.entries(row)) {
      if (!columns.has(k)) {
        columns.set(k, {
          types: new Set(),
          nulls: 0,
          seen: 0,
          values: new Set(),
          tooMany: false,
        });
      }
      const c = columns.get(k);
      c.seen++;
      const t = typeOf(v);
      c.types.add(t);
      if (v === null || v === undefined) c.nulls++;
      if (!c.tooMany) {
        c.values.add(String(v));
        if (c.values.size > 8) {
          c.tooMany = true;
          c.values.clear(); // drop them; we are not keeping free text around
        }
      }
    }
  }

  const out = [];
  for (const [name, c] of columns) {
    const col = {
      column: name,
      type: [...c.types].sort().join(" | "),
      present_in: c.seen + "/" + rows.length,
      nulls: c.nulls,
    };
    // Distinct values only when the column is plainly an enumeration AND its
    // name carries no hint of personal data AND we saw enough rows to judge.
    const longest = c.tooMany
      ? Infinity
      : [...c.values].reduce((m, s) => Math.max(m, s.length), 0);
    if (
      !c.tooMany &&
      rows.length >= 20 &&
      c.values.size <= 8 &&
      longest <= 20 &&
      !NEVER_ENUMERATE.test(name)
    ) {
      col.distinct_values = [...c.values].sort();
    }
    out.push(col);
  }

  return { sampled: rows.length, columns: out };
}

// Safe aggregate, derived not quoted: does the name field carry Bryan's
// convention? This is the one thing that decides whether a name-string join
// survives the migration, and a count answers it without printing a name.
function asteriskTally(rows, key) {
  if (!Array.isArray(rows)) return null;
  let single = 0, double = 0, plain = 0, other = 0;
  for (const r of rows) {
    const v = isPlainObject(r) ? r[key] : null;
    if (typeof v !== "string") { other++; continue; }
    const t = v.trimEnd();
    if (t.endsWith("**")) double++;
    else if (t.endsWith("*")) single++;
    else if (v.includes("*")) other++;
    else plain++;
  }
  return { ends_with_single_asterisk: single, ends_with_double_asterisk: double, no_asterisk: plain, other: other };
}

// Each action is tried several ways. A permission problem fails the same way
// every time; a PARAMETER problem fails only on the variant that carries it.
// Telling those two apart is the whole point of running this twice.
function variantsFor(action) {
  if (action === "version") return [{ label: "bare", body: { action } }];
  const v = [
    { label: "bare", body: { action } },
    { label: "limit", body: { action, limit: SAMPLE } },
  ];
  if (action === "contractors") v.push({ label: "search", body: { action, q: "a" } });
  if (action !== "contractors") v.push({ label: "limit-1", body: { action, limit: 1 } });
  return v;
}

async function callAction(secret, action, body) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(FIELD_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-field-secret": secret,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { action, ok: false, stage: "network", error: String(err && err.message || err) };
  }

  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }

  if (!res.ok) {
    return {
      action,
      ok: false,
      http_status: res.status,
      ms,
      // field-api's own error text is not sensitive; truncate anyway.
      error: (text || "").slice(0, 300),
    };
  }

  if (json === null) {
    return { action, ok: false, http_status: res.status, ms, error: "response was not JSON", first_120_chars: (text || "").slice(0, 120) };
  }

  const result = {
    action,
    ok: true,
    http_status: res.status,
    ms,
    envelope_keys: Object.keys(json).sort(),
  };

  if (typeof json.count !== "undefined") result.count = json.count;
  if (typeof json.capped !== "undefined") result.capped = json.capped;

  // Find the array the envelope carries, whatever it is called.
  const arrayKey = Object.keys(json).find((k) => Array.isArray(json[k]));
  if (arrayKey) {
    result.rows_key = arrayKey;
    result.shape = describeRows(json[arrayKey]);
    // Try the obvious candidates for a name column, without assuming one.
    const nameCol = (result.shape.columns || [])
      .map((c) => c.column)
      .find((c) => /^(name|customer_name|canonical_name|display_name)$/i.test(c));
    if (nameCol) {
      result.name_column = nameCol;
      result.asterisk_tally = asteriskTally(json[arrayKey], nameCol);
    }
  }

  if (action === "version") {
    // version is CONFIGURATION, not customer data — action names, build stamp,
    // which caller the secret resolves to. All of it is safe and all of it is
    // useful, so show the whole thing rather than describing its shape.
    result.value = json;
    delete result.shape;
    delete result.rows_key;
  }

  return result;
}

export default async (req) => {
  const secret = (process.env.FIELD_API_SECRET || "").trim();

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (!secret) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          problem: "FIELD_API_SECRET is not set on this site, or the site has not been redeployed since it was set.",
          fix: "Netlify > Site configuration > Environment variables. Then Deploys > Trigger deploy > Deploy site.",
        },
        null,
        2,
      ),
      { status: 503, headers },
    );
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("action");
  const actions = only ? ACTIONS.filter((a) => a === only) : ACTIONS;

  const results = [];
  for (const a of actions) {
    for (const v of variantsFor(a)) {
      const r = await callAction(secret, a, v.body);
      r.variant = v.label;
      r.sent = v.body;
      results.push(r);
    }
  }

  // ------------------------------------------------------------------
  //  THREE BUCKETS, NOT TWO. This is the whole correction.
  //
  //  "Did not work" is not one thing. An action the secret is NOT ALLOWED
  //  to call is the security design doing its job. An action the secret IS
  //  allowed to call that then FAILS is a broken thing wearing the same
  //  coat. Putting them in one bucket hides a fault behind a reassuring
  //  word, which is the failure this whole project is recovering from.
  // ------------------------------------------------------------------
  const isNotPermitted = (r) =>
    !r.ok && r.http_status === 400 && /not permitted|unknown/i.test(r.error || "");
  const isBroken = (r) => !r.ok && !isNotPermitted(r);

  const byAction = (pred) => [
    ...new Set(results.filter(pred).map((r) => r.action)),
  ];

  const worked = byAction((r) => r.ok);
  const notPermitted = byAction(isNotPermitted).filter((a) => !worked.includes(a));
  const broken = byAction(isBroken).filter((a) => !worked.includes(a));

  // What field-api itself says this secret may do, straight from `version`.
  const versionRow = results.find((r) => r.action === "version" && r.ok);
  const allowedPerApi =
    (versionRow && versionRow.value && Array.isArray(versionRow.value.actions))
      ? versionRow.value.actions
      : null;

  const summary = {
    secret_present: true,
    actions_that_worked: worked,
    actions_refused_on_purpose: notPermitted,
    actions_that_are_BROKEN: broken,
    verdict:
      broken.length > 0
        ? "PROBLEM. " + broken.join(", ") + " is allowed for this secret but FAILED. That is a fault, not a permission. Do not read the refusals as an all-clear."
        : worked.length > 0
          ? "Healthy. Everything this secret is allowed to do, it did."
          : "Nothing worked at all — check the secret.",
  };

  if (allowedPerApi) {
    summary.actions_this_secret_is_allowed = allowedPerApi;
    const allowedButFailed = allowedPerApi.filter((a) => broken.includes(a));
    if (allowedButFailed.length) {
      summary.allowed_but_failing = allowedButFailed;
    }
  }

  return new Response(JSON.stringify({ summary, results }, null, 2), {
    status: 200,
    headers,
  });
};
