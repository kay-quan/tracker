/* Test harness for app.js — runs it in a stubbed DOM under node.
   The bootstrap at the end of app.js is stripped so loading doesn't try to sign in. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// The app is served from the repo root, matching GitHub Pages exactly.
const PUB = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(PUB, f), "utf8");

let pass = 0, fail = 0;
const failures = [];
const pending = [];
/* Async tests must be awaited or a rejected promise counts as a pass -- exactly the
   kind of silently-green suite that lets a data-loss bug ship. */
function t(name, fn) {
  const record = (e) => { fail++; failures.push(name + "\n      " + e.message); };
  let r;
  try {
    r = fn();
  } catch (e) {
    record(e);
    return;
  }
  if (r && typeof r.then === "function") {
    pending.push(r.then((v) => {
      if (v === false) record(new Error("returned false")); else pass++;
    }, record));
    return;
  }
  if (r === false) record(new Error("returned false")); else pass++;
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error((what || "") + " expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
};

/* ---------- stubs ---------- */
const noop = () => {};
const el = () => ({
  innerHTML: "", textContent: "", value: "", className: "", style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, removeChild: noop, remove: noop, focus: noop, blur: noop,
  addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [],
  closest: () => null, scrollIntoView: noop, children: [], parentNode: null,
});
const doc = {
  scripts: [{ getAttribute: () => "app.js?v=39" }],
  body: el(), documentElement: el(), head: el(),
  getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), addEventListener: noop, removeEventListener: noop,
  createDocumentFragment: () => el(),
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  document: doc,
  navigator: { onLine: true, sendBeacon: noop, clipboard: { writeText: () => Promise.resolve() } },
  location: { href: "https://example.test/", pathname: "/", search: "", hash: "", origin: "https://example.test" },
  history: { replaceState: noop },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  Cloud: {
    restore: noop, signedIn: () => false, signIn: noop, signOut: noop,
    load: () => Promise.resolve(null), save: () => Promise.resolve(),
    diagnostics: () => ({}), token: () => null,
  },
  requestAnimationFrame: (f) => setTimeout(f, 0),
  addEventListener: noop, removeEventListener: noop, open: noop, alert: noop,
  scrollTo: noop, scrollY: 0, innerWidth: 1200, innerHeight: 900,
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* The app loads the database from Firestore at runtime. Tests load the very same
   payload the import writes, so what is tested is what ships -- no second format. */
const payloadPath = path.join(__dirname, "..", "artists.payload.json");
if (!fs.existsSync(payloadPath)) {
  console.error("\nMissing " + payloadPath +
    "\nGenerate it first:  python3 tools/gen_artists_js.py --apply\n");
  process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
sandbox.ARTIST_ACTS = payload.acts;
sandbox.ARTIST_LOOKUP = payload.lookup;
sandbox.ARTIST_FESTIVALS = payload.festivals;
sandbox.ARTIST_STATS = payload.stats;

// Strip the three bootstrap lines so loading doesn't kick off a sign-in.
let app = read("app.js").replace(
  /Cloud\.restore\(\);[\s\S]*$/,
  "globalThis.__T = {akey, artistRec, artistBest, isArtistDirect, clash, warmFor,\n" +
  "  lineupRows, materialise, pitchUrl, outreachLineups, defaultData, withDefaults,\n" +
  "  draftEach, pickAllReachable, markDraftedSent,\n" +
  "  setDB: (d) => { DB = d; }, getDB: () => DB, setState: (s) => { state = s; }, getState: () => state};\n"
);
vm.runInContext(app, sandbox, { filename: "app.js" });
const T = sandbox.__T;
const A = sandbox.ARTIST_ACTS, L = sandbox.ARTIST_LOOKUP, F = sandbox.ARTIST_FESTIVALS;

/* ---------- database integrity ---------- */

t("database loaded", () => {
  eq(sandbox.ARTIST_STATS.acts, 723, "acts");
  eq(sandbox.ARTIST_STATS.festivals, 17, "festivals");
});

t("every lookup address has an @", () =>
  Object.keys(L).every((k) => L[k].e.indexOf("@") > 0));

t("every contact carries its source URL", () => {
  const bad = [];
  Object.keys(A).forEach((k) => {
    if (A[k].alias) return;
    (A[k].c || []).forEach((c) => { if (!c.s) bad.push(A[k].n + " / " + c.e); });
  });
  if (bad.length) throw new Error(bad.length + " addresses with no source, e.g. " + bad[0]);
});

t("no stale-flagged address outranks a clean one", () => {
  Object.keys(A).forEach((k) => {
    const cs = A[k].c || [];
    cs.forEach((c, i) => {
      if (c.r && cs.slice(i + 1).some((d) => !d.r))
        throw new Error(A[k].n + ": stale address sorted above a clean one");
    });
  });
});

t("every festival act resolves to a record", () => {
  Object.keys(F).forEach((f) => F[f].forEach((k) => {
    if (!A[k]) throw new Error(f + " references unknown act key " + k);
  }));
});

/* ---------- name resolution ---------- */

t("akey normalises punctuation and case", () => {
  eq(T.akey("Sneak's Birthday Beats"), "sneaksbirthdaybeats");
  eq(T.akey("A-Trak"), "atrak");
});

t("alias keys resolve to the real record", () => {
  const aliases = Object.keys(A).filter((k) => A[k].alias);
  if (!aliases.length) throw new Error("no alias keys generated");
  aliases.forEach((k) => {
    const rec = T.artistRec(A[k].n);
    if (!rec || rec.alias) throw new Error("alias " + k + " did not resolve");
  });
});

t("artistBest returns the top-ranked address", () => {
  const k = Object.keys(A).find((x) => !A[x].alias && (A[x].c || []).length > 1);
  eq(T.artistBest(A[k].n).e, A[k].c[0].e, A[k].n);
});

/* ---------- isArtistDirect ---------- */

t("role mailbox is never the artist", () => {
  eq(T.isArtistDirect("Novaline", "bookings@novaline.com"), false);
  eq(T.isArtistDirect("Novaline", "management@novaline.com"), false);
  eq(T.isArtistDirect("Novaline", "info@novaline.com"), false);
});

/* Fixtures here are invented on purpose. Real addresses out of the database must never
   be hardcoded into this file — it is committed to a PUBLIC repo. Anything that needs
   a real record reads it out of the loaded database at runtime instead. */

t("act's name at an agency is an alias, not the act", () =>
  eq(T.isArtistDirect("Novaline", "novaline@bigtalentagency.com"), false));

t("free-host address carrying the name is direct", () =>
  eq(T.isArtistDirect("Novaline", "novalinemusic@gmail.com"), true));

t("own-domain personal address is direct", () =>
  eq(T.isArtistDirect("Novaline", "novaline@novaline.com"), true));

t("unrelated address is not direct", () =>
  eq(T.isArtistDirect("Novaline", "dana@someothermgmt.com"), false));

t("the real top-ranked address is never the act's own inbox when a manager exists", () => {
  // Derived from the database, not hardcoded: a manager always outranks the artist.
  const k = Object.keys(A).find((x) => !A[x].alias && (A[x].c || []).length > 1 &&
    A[x].c.some((c) => c.t === "management"));
  if (!k) throw new Error("no act with a management address to check");
  const top = A[k].c[0];
  if (T.isArtistDirect(A[k].n, top.e) && A[k].c.some((c) => !T.isArtistDirect(A[k].n, c.e)))
    throw new Error(A[k].n + ": own inbox outranked a third-party desk");
});

/* ---------- lineup join ---------- */

const baseDB = () => {
  const d = T.defaultData();
  d.outreach = [];
  d.gigs = [];
  d.clients = [];
  return d;
};

t("lineup renders every act from the database", () => {
  T.setDB(baseDB());
  const fest = "Escape Halloween 2026";
  const rows = T.lineupRows(fest, []);
  eq(rows.length, F[fest].length, "act count");
});

t("acts with an address get one attached", () => {
  T.setDB(baseDB());
  const rows = T.lineupRows("Escape Halloween 2026", []);
  const withMail = rows.filter((r) => r.email).length;
  if (withMail < 20) throw new Error("only " + withMail + " acts got addresses");
});

t("an existing outreach row keeps its status and identity", () => {
  const db = baseDB();
  const name = A[F["Escape Halloween 2026"][0]].n;
  db.outreach = [{ id: "mine", venue: name, festival: "Escape Halloween 2026",
                   status: "booked", email: "kept@example.com", notes: "my note" }];
  T.setDB(db);
  const row = T.lineupRows("Escape Halloween 2026", db.outreach).find((r) => r.id === "mine");
  if (!row) throw new Error("existing row was dropped from the lineup");
  eq(row.status, "booked", "status");
  eq(row.email, "kept@example.com", "own address must win over the database");
  eq(row.notes, "my note", "notes");
});

t("the database fills a blank address on an existing row", () => {
  const db = baseDB();
  const key = F["Escape Halloween 2026"].find((k) => L[k]);
  const name = A[key].n;
  db.outreach = [{ id: "mine", venue: name, festival: "Escape Halloween 2026",
                   status: "to-contact", email: "" }];
  T.setDB(db);
  const row = T.lineupRows("Escape Halloween 2026", db.outreach).find((r) => r.id === "mine");
  eq(row.email, L[key].e, "blank address should be filled from the database");
});

t("a hand-made lineup the database doesn't know still renders", () => {
  const db = baseDB();
  db.outreach = [{ id: "x1", venue: "Some Local DJ", festival: "My Own Night 2026",
                   status: "to-contact", email: "" }];
  T.setDB(db);
  T.setState({ view: "outreach", outreachMode: "lineups", picked: {} });
  const html = T.outreachLineups(db.outreach);
  if (html.indexOf("My Own Night 2026") < 0) throw new Error("custom lineup card missing");
  if (html.indexOf("Escape Halloween 2026") < 0) throw new Error("database lineups missing");
});

t("synthetic rows have stable ids across renders", () => {
  T.setDB(baseDB());
  const a = T.lineupRows("Wasteland 2026", []).map((r) => r.id);
  const b = T.lineupRows("Wasteland 2026", []).map((r) => r.id);
  eq(JSON.stringify(a), JSON.stringify(b));
});

t("materialise turns a synthetic row into a real stored one", () => {
  const db = baseDB();
  T.setDB(db);
  const row = T.lineupRows("Wasteland 2026", [])[0];
  if (!row._db) throw new Error("expected a synthetic row");
  const real = T.materialise(row);
  eq(db.outreach.length, 1, "stored rows");
  eq(real.venue, row.venue, "name carried over");
  if (real._db) throw new Error("materialised row still flagged synthetic");
  if (real.id.indexOf("a:") === 0) throw new Error("materialised row kept its synthetic id");
});

t("materialise leaves an already-real row alone", () => {
  const db = baseDB();
  db.outreach = [{ id: "r1", venue: "X", status: "contacted" }];
  T.setDB(db);
  eq(T.materialise(db.outreach[0]).id, "r1");
  eq(db.outreach.length, 1, "must not duplicate");
});

/* ---------- guards ---------- */

t("warmFor spots an existing client", () => {
  const db = baseDB();
  db.clients = [{ name: "Jay", email: "Jay@Example.com" }];
  T.setDB(db);
  const w = T.warmFor("jay@example.com");
  if (!w) throw new Error("case-insensitive client match failed");
  eq(w.kind, "client");
});

t("warmFor spots a contact already in the pipeline", () => {
  const db = baseDB();
  db.outreach = [{ id: "o1", venue: "Other Act", email: "mgr@agency.com", status: "contacted" }];
  T.setDB(db);
  eq(T.warmFor("mgr@agency.com").kind, "outreach");
});

t("warmFor ignores an untouched pipeline row", () => {
  const db = baseDB();
  db.outreach = [{ id: "o1", venue: "Other Act", email: "mgr@agency.com", status: "to-contact" }];
  T.setDB(db);
  eq(T.warmFor("mgr@agency.com"), null);
});

t("clash finds a gig on the day", () => {
  const db = baseDB();
  db.gigs = [{ id: "g1", date: "2026-10-31", client: "X" }];
  T.setDB(db);
  if (!T.clash("2026-10-31")) throw new Error("should clash");
  if (T.clash("2026-11-01")) throw new Error("should not clash");
});

/* ---------- pitch wording ---------- */

t("manager pitch talks about the act in the third person", () => {
  const db = baseDB();
  db.settings.yourName = "Kevin Quan";
  db.settings.eventCity = "Los Angeles";
  T.setDB(db);
  const url = T.pitchUrl({ venue: "Novaline", email: "dana@someothermgmt.com" }, "Escape Halloween 2026");
  const body = decodeURIComponent(url.match(/&body=([^&]*)/)[1]);
  if (body.indexOf("whether Novaline needs any coverage") < 0)
    throw new Error("manager wording missing:\n" + body);
});

t("direct pitch addresses the act itself", () => {
  const db = baseDB();
  db.settings.yourName = "Kevin Quan";
  T.setDB(db);
  const url = T.pitchUrl({ venue: "Novaline", email: "novalinemusic@gmail.com" }, "Escape Halloween 2026");
  const body = decodeURIComponent(url.match(/&body=([^&]*)/)[1]);
  if (body.indexOf("your set") < 0) throw new Error("direct wording missing:\n" + body);
});

t("pitch uses the manager's first name when known", () => {
  const db = baseDB();
  db.settings.yourName = "Kevin Quan";
  T.setDB(db);
  const key = Object.keys(L).find((k) => L[k].p && L[k].p.indexOf(" ") > 0);
  const url = T.pitchUrl({ venue: A[key].n, email: L[key].e }, "Escape Halloween 2026");
  const body = decodeURIComponent(url.match(/&body=([^&]*)/)[1]);
  const first = L[key].p.split(/\s+/)[0];
  if (body.indexOf("Hi " + first) !== 0) throw new Error("expected 'Hi " + first + "', got:\n" + body.slice(0, 60));
});

t("pitch goes to the picked address in To, not BCC", () => {
  T.setDB(baseDB());
  const url = T.pitchUrl({ venue: "Novaline", email: "n@gmail.com" }, "F");
  if (url.indexOf("&to=") < 0) throw new Error("no To recipient");
  if (url.indexOf("bcc") >= 0) throw new Error("per-artist draft should not use BCC");
});

/* ---------- drafting is not contact ---------- */

const FEST = "Wasteland 2026";
function drafted() {
  const db = baseDB();
  db.settings.yourName = "Kevin Quan";
  T.setDB(db);
  T.setState({ view: "outreach", outreachMode: "lineups", picked: {} });
  sandbox.open = noop;                       // swallow the draft windows
  T.pickAllReachable(FEST);
  T.draftEach(FEST);
  return db;
}

t("select all picks only acts with an address", () => {
  const db = baseDB();
  T.setDB(db);
  T.setState({ view: "outreach", picked: {} });
  T.pickAllReachable(FEST);
  const picked = Object.keys(T.getState().picked).length;
  const reachable = F[FEST].filter((k) => L[k]).length;
  eq(picked, reachable, "picked vs reachable");
});

t("drafting stores the acts but does NOT mark them contacted", () => {
  const db = drafted();
  if (!db.outreach.length) throw new Error("nothing stored");
  const contacted = db.outreach.filter((r) => r.status === "contacted").length;
  eq(contacted, 0, "must not claim contact before anything is sent");
  if (!db.outreach.every((r) => r.draftedAt)) throw new Error("draftedAt not recorded");
});

t("drafted acts render as drafted, not as emailed", () => {
  const db = drafted();
  T.setState({ view: "outreach", outreachMode: "lineups", picked: {} });
  const html = T.outreachLineups(db.outreach);
  if (html.indexOf("pick-act drafted") < 0) throw new Error("no drafted styling in output");
});

t("confirming turns drafted into contacted", () => {
  const db = drafted();
  const n = T.markDraftedSent();
  if (!n) throw new Error("nothing was marked");
  eq(db.outreach.filter((r) => r.status === "contacted").length, n, "contacted count");
  if (!db.outreach.filter((r) => r.status === "contacted").every((r) => r.lastContact))
    throw new Error("lastContact not stamped");
});

t("confirming twice does not re-mark anything", () => {
  drafted();
  T.markDraftedSent();
  eq(T.markDraftedSent(), 0, "second confirm should be a no-op");
});

t("drafting again skips acts already contacted", () => {
  const db = drafted();
  T.markDraftedSent();
  const already = db.outreach.length;
  T.pickAllReachable(FEST);
  T.draftEach(FEST);
  eq(db.outreach.length, already, "must not duplicate rows on a second pass");
  eq(db.outreach.filter((r) => r.status === "contacted").length, already, "all still contacted");
});

/* ================= sync: one document per record =================
   Run against the real cloud.js in its own sandbox, with fetch faked as an in-memory
   Firestore. These are the tests that matter most: a bug here loses real data. */

function makeCloud() {
  const store = new Map();               // full doc path -> json string
  const calls = { commits: 0, writes: 0, gets: 0, lists: 0 };

  const box = {
    console, JSON, Date, Math, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { platform: "test" },
    async fetch(url, opts) {
      opts = opts || {};
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
      if (url.indexOf(":commit") >= 0) {
        calls.commits++;
        const w = JSON.parse(opts.body).writes;
        calls.writes += w.length;
        w.forEach((x) => {
          if (x.delete) store.delete(x.delete.split("/documents/")[1]);
          else store.set(x.update.name.split("/documents/")[1],
                         x.update.fields.json.stringValue);
        });
        return ok({});
      }
      const path = url.split("/documents/")[1].split("?")[0];
      if (opts.method === "PATCH") {                       // saveRef
        store.set(path, JSON.parse(opts.body).fields.json.stringValue);
        return ok({});
      }
      // a listing if anything is filed beneath this path, otherwise a get
      const kids = [...store.keys()].filter((k) => k.startsWith(path + "/"));
      if (path.endsWith("/rec")) {
        calls.lists++;
        return ok({ documents: kids.map((k) => ({
          name: "projects/p/databases/(default)/documents/" + k,
          fields: { json: { stringValue: store.get(k) } } })) });
      }
      calls.gets++;
      if (!store.has(path)) return { ok: false, status: 404, json: async () => ({}) };
      return ok({ fields: { json: { stringValue: store.get(path) } } });
    },
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(read("cloud.js") + "\nglobalThis.__C = Cloud;", box, { filename: "cloud.js" });
  const C = box.__C;
  C.session = { idToken: "t", refreshToken: "r", expiresAt: Date.now() + 3.6e6, uid: "U1" };
  return { C, store, calls };
}

const sampleData = () => ({
  settings: { yourName: "Kevin Quan", incomeGoal: 50000 },
  gigs: [{ id: "g1", client: "A" }, { id: "g2", client: "B" }],
  invoices: [{ id: "i1", number: "INV-1" }],
  clients: [{ id: "c1", name: "A" }],
  outreach: [{ id: "o1", venue: "Act", status: "to-contact" }],
  todos: [{ id: "t1", text: "thing" }],
  income: [], expenses: [],
  localEvents: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
  localEventsFetchedAt: 123,
});

t("migration moves a single-blob tracker into per-record documents", async () => {
  const { C, store } = makeCloud();
  store.set("trackers/U1", JSON.stringify(sampleData()));   // legacy blob
  const got = await C.load();
  eq(got.gigs.length, 2, "gigs");
  eq(got.invoices.length, 1, "invoices");
  eq(got.localEvents.length, 3, "localEvents");
  eq(got.settings.yourName, "Kevin Quan", "settings");
  if (!store.has("trackers/U1/rec/g.g1")) throw new Error("gig not written as its own doc");
  if (!store.has("trackers/U1/ref/events")) throw new Error("events doc not written");
  if (!store.has("trackers/U1/ref/meta")) throw new Error("meta doc not written");
});

t("migration leaves the old blob untouched as a rollback", async () => {
  const { C, store } = makeCloud();
  const blob = JSON.stringify(sampleData());
  store.set("trackers/U1", blob);
  await C.load();
  eq(store.get("trackers/U1"), blob, "legacy document must not be altered");
});

t("a migrated tracker reads back identically", async () => {
  const { C, store } = makeCloud();
  const original = sampleData();
  store.set("trackers/U1", JSON.stringify(original));
  await C.load();
  const fresh = makeCloud();
  fresh.store.clear();
  store.forEach((v, k) => fresh.store.set(k, v));
  const got = await fresh.C.load();
  ["gigs", "invoices", "clients", "outreach", "todos", "localEvents"].forEach((k) => {
    eq(JSON.stringify((got[k] || []).slice().sort((a, b) => a.id < b.id ? -1 : 1)),
       JSON.stringify((original[k] || []).slice().sort((a, b) => a.id < b.id ? -1 : 1)), k);
  });
  eq(JSON.stringify(got.settings), JSON.stringify(original.settings), "settings");
  eq(got.localEventsFetchedAt, 123, "scalar");
});

t("saving an unchanged tracker writes nothing at all", async () => {
  const { C, store, calls } = makeCloud();
  store.set("trackers/U1", JSON.stringify(sampleData()));
  const data = await C.load();
  const before = calls.writes;
  await C.save(data);
  eq(calls.writes, before, "an unchanged save must not write");
});

t("editing one record writes only that record", async () => {
  const { C, store, calls } = makeCloud();
  store.set("trackers/U1", JSON.stringify(sampleData()));
  const data = await C.load();
  const before = calls.writes;
  data.gigs.find((g) => g.id === "g2").client = "B changed";
  await C.save(data);
  eq(calls.writes - before, 1, "exactly one document should change");
  eq(JSON.parse(store.get("trackers/U1/rec/g.g2")).client, "B changed", "stored value");
});

t("deleting a record deletes its document", async () => {
  const { C, store } = makeCloud();
  store.set("trackers/U1", JSON.stringify(sampleData()));
  const data = await C.load();
  data.gigs = data.gigs.filter((g) => g.id !== "g1");
  await C.save(data);
  if (store.has("trackers/U1/rec/g.g1")) throw new Error("deleted gig still stored");
  if (!store.has("trackers/U1/rec/g.g2")) throw new Error("wrong gig deleted");
});

t("THE CLOBBER TEST: a stale device no longer overwrites another's edits", async () => {
  // Both devices load the same tracker. Each edits a DIFFERENT record. Under the old
  // whole-blob model the second save destroyed the first; both must now survive.
  const { C, store } = makeCloud();
  store.set("trackers/U1", JSON.stringify(sampleData()));
  await C.load();

  const laptop = makeCloud(); laptop.store.clear(); store.forEach((v, k) => laptop.store.set(k, v));
  const phone  = makeCloud(); phone.store.clear();  store.forEach((v, k) => phone.store.set(k, v));
  const lData = await laptop.C.load();
  const pData = await phone.C.load();

  lData.invoices.find((i) => i.id === "i1").number = "INV-EDITED-ON-LAPTOP";
  await laptop.C.save(lData);
  // phone's copy is now stale, and saves a change to a different record
  laptop.store.forEach((v, k) => phone.store.set(k, v));
  pData.todos.find((x) => x.id === "t1").text = "EDITED-ON-PHONE";
  await phone.C.save(pData);

  const after = makeCloud(); after.store.clear();
  phone.store.forEach((v, k) => after.store.set(k, v));
  const final = await after.C.load();
  eq(final.invoices[0].number, "INV-EDITED-ON-LAPTOP", "laptop's edit must survive");
  eq(final.todos.find((x) => x.id === "t1").text, "EDITED-ON-PHONE", "phone's edit must survive");
});

t("signing out clears the diff baseline", () => {
  const { C } = makeCloud();
  C.lastPush = { "ref/meta": "{}" };
  C.signOut();
  eq(C.lastPush, null, "a stale baseline would let the next account be overwritten");
});

t("local events stay one document, not 462", async () => {
  const { C, store } = makeCloud();
  const d = sampleData();
  d.localEvents = Array.from({ length: 462 }, (_, i) => ({ id: "e" + i }));
  store.set("trackers/U1", JSON.stringify(d));
  const got = await C.load();
  eq(got.localEvents.length, 462, "round trip");
  eq([...store.keys()].filter((k) => k.startsWith("trackers/U1/rec/")).length, 6,
     "only real records get their own document");
});

t("the artist database is never touched by a save", async () => {
  const { C, store } = makeCloud();
  store.set("trackers/U1", JSON.stringify(sampleData()));
  store.set("trackers/U1/ref/artists", JSON.stringify({ acts: { x: 1 } }));
  const data = await C.load();
  data.gigs[0].client = "changed";
  await C.save(data);
  if (!store.has("trackers/U1/ref/artists")) throw new Error("artist database was deleted");
});

t("a first run with no data anywhere returns null", async () => {
  const { C } = makeCloud();
  eq(await C.load(), null);
});

/* ---------- report ---------- */
Promise.all(pending).then(() => {
  console.log("");
  failures.forEach((f) => console.log("  FAIL  " + f));
  console.log("");
  console.log((fail ? "FAILED" : "PASSED") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
});
