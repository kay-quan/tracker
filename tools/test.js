/* Test harness for app.js — runs it in a stubbed DOM under node.
   The bootstrap at the end of app.js is stripped so loading doesn't try to sign in. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const PUB = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUB, f), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    pass++;
  } catch (e) {
    fail++;
    failures.push(name + "\n      " + e.message);
  }
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
  scripts: [{ getAttribute: () => "app.js?v=38" }],
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

// artists.js assigns onto window.
vm.runInContext(read("artists.js"), sandbox, { filename: "artists.js" });

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

/* ---------- report ---------- */
console.log("");
failures.forEach((f) => console.log("  FAIL  " + f));
console.log("");
console.log((fail ? "FAILED" : "PASSED") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
