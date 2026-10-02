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
  scripts: [{ getAttribute: () => "app.js?v=56" }],
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
  "  draftEach, pickAllReachable, markDraftedSent, invoiceStatus, invoicePaid,\n" +
  "  linkedPayments, recordPayment, invoiceTotals, invoiceById,\n" +
  "  followersOf, instagramOf, fmtFollowers, inBand, FOLLOWER_BANDS,\n" +
  "  gigPaid, gigOwed, gigIsPaid, moneyByMonth, owedTotals, toggleGigPaid, gigValue,\n" +
  "  savePersonal, personalById, PERSONAL_KINDS, ytdFigures, workGigs,\n" +
  "  personalDays, spanLabel, gameStats, streakFrom, bankXP, taskXP, XP_PER_LEVEL, isoOf,\n" +
  "  battleState, todaysQuests, heroOf, HERO_OPTIONS, PLAYBOOK, EVIDENCE, mobOfDay,\n" +
  "  mobFor, MOBS, MOB_SPRITES, mobSVG, VIEWS, CHANGELOG, assignTop,\n" +
  "  STATS, PRIORITIES, statSheet, streakMult, statLevel, guessStat, statOf, prioOf, earnedXP,\n" +
  "  previewXP, awardTask, rollLoot, lootItem, LOOT, LOOT_CHANCE, STREAK_MILESTONES, milestonesDue,\n" +
  "  heroTitle, addDays, avatarOf, avatarItems, avatarURL, weaponActions, closetBase, closetName,\n" +
  "  closetWear, AVATAR_DEFAULT, bossProgress, rewardProgress, mapOpen, WORLD, STAT_GUIDE, STAT_WORDS,\n" +
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
  // Lineup cards collapse to their heading, so open this one before reading the chips.
  T.setState({ view: "outreach", outreachMode: "lineups", picked: {},
               openLineups: { [FEST]: true } });
  const html = T.outreachLineups(db.outreach);
  if (html.indexOf("pick-act drafted") < 0) throw new Error("no drafted styling in output");
});

t("a collapsed lineup still shows its heading and counts", () => {
  const db = drafted();
  T.setState({ view: "outreach", outreachMode: "lineups", picked: {}, openLineups: {} });
  const html = T.outreachLineups(db.outreach);
  if (html.indexOf(FEST) < 0) throw new Error("festival name missing when collapsed");
  if (html.indexOf("reachable") < 0) throw new Error("counts missing when collapsed");
  if (html.indexOf("pick-act") >= 0) throw new Error("act chips should not render when collapsed");
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

/* ================= invoices: paid, and un-paid =================
   An invoice reads as paid from TWO places - its status field and the payments
   recorded against it. Missing that is what made "mark unpaid" look broken. */

const invDB = () => {
  const d = T.defaultData();
  d.clients = [{ id: "c1", name: "A Client" }];
  d.invoices = [{ id: "i1", number: "INV-1", clientId: "c1", status: "sent",
                  sentDate: "2026-08-01",
                  items: [{ description: "Shoot", qty: 1, rate: 400 }] }];
  d.income = [];
  return d;
};

t("recording full payment marks the invoice paid", () => {
  const db = invDB(); T.setDB(db);
  const inv = db.invoices[0];
  T.recordPayment(inv, { amount: 400 });
  eq(T.invoiceStatus(inv), "paid");
  eq(db.income.length, 1, "income row created");
});

t("clearing the status alone does NOT un-pay it -- the payment still does", () => {
  const db = invDB(); T.setDB(db);
  const inv = db.invoices[0];
  T.recordPayment(inv, { amount: 400 });
  inv.status = "sent";                      // what the dropdown used to do
  eq(T.invoiceStatus(inv), "paid", "this is the bug the fix exists for");
});

t("removing the linked payments is what actually un-pays it", () => {
  const db = invDB(); T.setDB(db);
  const inv = db.invoices[0];
  T.recordPayment(inv, { amount: 400 });
  db.income = db.income.filter((i) => i.invoiceId !== inv.id);
  inv.status = "sent";
  eq(T.invoiceStatus(inv), "sent");
  eq(T.invoicePaid(inv), 0, "nothing left recorded");
});

t("linkedPayments finds only this invoice's payments", () => {
  const db = invDB(); T.setDB(db);
  const inv = db.invoices[0];
  T.recordPayment(inv, { amount: 400 });
  db.income.push({ id: "x", amount: 99, invoiceId: null, date: "2026-08-02" });
  db.income.push({ id: "y", amount: 50, invoiceId: "other", date: "2026-08-02" });
  eq(T.linkedPayments(inv).length, 1, "must not sweep up unrelated income");
});

t("a part payment reads as partial, not paid", () => {
  const db = invDB(); T.setDB(db);
  const inv = db.invoices[0];
  T.recordPayment(inv, { amount: 100 });
  eq(T.invoiceStatus(inv), "partial");
});

t("standalone income needs no invoice and never touches one", () => {
  const db = invDB(); T.setDB(db);
  const inv = db.invoices[0];
  // exactly what "Log a payment" stores when nothing is linked
  db.income.push({ id: "p1", date: "2026-07-04", amount: 250, clientId: "",
                   invoiceId: null, source: "Print sales", method: "Zelle" });
  eq(T.invoicePaid(inv), 0, "unlinked money must not pay an invoice off");
  eq(T.invoiceStatus(inv), "sent", "invoice untouched");
  eq(db.income.filter((i) => !i.invoiceId).length, 1, "logged on its own");
});

/* ================= follower bands ================= */

t("follower counts come from the database, and missing means missing", () => {
  const withCount = Object.keys(A).find((k) => !A[k].alias && typeof A[k].fo === "number");
  const without = Object.keys(A).find((k) => !A[k].alias && A[k].fo === undefined);
  eq(T.followersOf(A[withCount].n), A[withCount].fo, "reads the stored count");
  eq(T.followersOf(without ? A[without].n : "Nobody At All"), null, "never guesses one");
  eq(T.followersOf("An Act That Does Not Exist"), null, "unknown act");
});

t("instagram is reduced to a handle, never rebuilt from a name", () => {
  const k = Object.keys(A).find((x) => !A[x].alias && A[x].ig);
  const h = T.instagramOf(A[k].n);
  if (!h) throw new Error("no handle extracted");
  if (h.indexOf("/") >= 0 || h.indexOf("http") === 0) throw new Error("URL leaked into the handle: " + h);
  if (A[k].ig.indexOf(h) < 0) throw new Error("handle isn't in the stored URL");
  eq(T.instagramOf("An Act That Does Not Exist"), "", "no handle invented");
});

t("follower counts format compactly", () => {
  eq(T.fmtFollowers(950), "950");
  eq(T.fmtFollowers(1300), "1.3K");
  eq(T.fmtFollowers(12000), "12K");
  eq(T.fmtFollowers(2400000), "2.4M");
  eq(T.fmtFollowers(null), "");
});

t("bands split the acts without gaps or overlap", () => {
  const real = Object.keys(A).filter((k) => !A[k].alias);
  const counted = {};
  T.FOLLOWER_BANDS.forEach((b) => { counted[b.key] = 0; });
  real.forEach((k) => {
    const hits = T.FOLLOWER_BANDS.filter((b) => T.inBand(A[k].n, b.key));
    if (hits.length !== 1) {
      throw new Error(A[k].n + " (" + A[k].fo + ") matched " + hits.length + " bands");
    }
    counted[hits[0].key]++;
  });
  const sum = Object.values(counted).reduce((a, b) => a + b, 0);
  eq(sum, real.length, "every act lands in exactly one band");
});

t("'any' shows everything, including acts with no count", () => {
  const real = Object.keys(A).filter((k) => !A[k].alias);
  eq(real.every((k) => T.inBand(A[k].n, "all")), true);
});

t("under-50K really is under 50K", () => {
  Object.keys(A).forEach((k) => {
    if (A[k].alias) return;
    if (T.inBand(A[k].n, "u50")) {
      const f = A[k].fo;
      if (!(f >= 10000 && f < 50000)) throw new Error(A[k].n + " has " + f + " in the 10K-50K band");
    }
  });
});

/* ================= money: made, owed, projected ================= */

const moneyDB = () => {
  const d = T.defaultData();
  d.clients = [{ id: "c1", name: "Jay Matsumoto" }];
  d.gigs = [
    { id: "g1", title: "Koya — Academy LA", date: "2026-08-07", clientId: "c1", rateType: "flat", rate: 400 },
    { id: "g2", title: "Hershe", date: "2026-08-20", clientId: "c1", rateType: "flat", rate: 250 },
    { id: "g3", title: "Rate not agreed", date: "2026-08-28", clientId: "c1", rateType: "flat", rate: 0 },
    { id: "g4", title: "Booked ahead", date: "2099-01-10", clientId: "c1", rateType: "flat", rate: 600 },
  ];
  d.income = [];
  return d;
};

t("a gig with no rate is TBD, not worth zero", () => {
  const db = moneyDB(); T.setDB(db);
  const g3 = db.gigs.find((g) => g.id === "g3");
  eq(T.gigValue(g3), 0, "no rate set");
  eq(T.gigIsPaid(g3), false, "must not count as paid just because it totals zero");
  eq(T.gigOwed(g3), 0, "and nothing concrete is owed either");
  eq(T.owedTotals(db.gigs).tbd, 1, "counted separately as TBD");
});

t("owed splits work already done from work booked ahead", () => {
  const db = moneyDB(); T.setDB(db);
  const o = T.owedTotals(db.gigs);
  eq(o.work, 650, "Koya + Hershe are in the past");
  eq(o.booked, 600, "the 2099 gig is not late, just booked");
  eq(o.total, 1250);
});

t("a part payment reduces what is owed without marking it paid", () => {
  const db = moneyDB(); T.setDB(db);
  db.income.push({ id: "p1", amount: 150, gigId: "g1", date: "2026-08-10" });
  const g1 = db.gigs[0];
  eq(T.gigPaid(g1), 150);
  eq(T.gigOwed(g1), 250, "the rest is still owed");
  eq(T.gigIsPaid(g1), false);
  eq(T.owedTotals(db.gigs).work, 500, "owed total drops by what came in");
});

t("month cards report made, owed and projected", () => {
  const db = moneyDB(); T.setDB(db);
  db.income.push({ id: "p1", amount: 400, gigId: "g1", date: "2026-08-10" });
  const m = T.moneyByMonth(db.gigs)["2026-08"];
  eq(m.made, 400, "the paid gig");
  eq(m.upcoming, 250, "the unpaid one");
  eq(m.tbd, 1, "and the one with no rate");
  eq(m.made + m.upcoming, 650, "projected");
});

t("ticking a gig paid logs a payment for exactly what is outstanding", () => {
  const db = moneyDB(); T.setDB(db);
  db.income.push({ id: "p1", amount: 100, gigId: "g1", date: "2026-08-10" });
  T.toggleGigPaid("g1", true);
  eq(db.income.length, 2, "one new payment");
  const added = db.income.find((i) => i.id !== "p1");
  eq(added.amount, 300, "the balance, not the whole fee again");
  eq(added.gigId, "g1", "linked to the gig");
  eq(T.gigIsPaid(db.gigs[0]), true);
});

t("un-ticking removes the payments and leaves other gigs alone", () => {
  const db = moneyDB(); T.setDB(db);
  db.income.push({ id: "keep", amount: 250, gigId: "g2", date: "2026-08-25" });
  T.toggleGigPaid("g1", true);
  T.toggleGigPaid("g1", false);
  eq(T.gigPaid(db.gigs[0]), 0, "g1 cleared");
  eq(T.gigIsPaid(db.gigs[0]), false);
  eq(db.income.filter((i) => i.gigId === "g2").length, 1, "g2's payment untouched");
});

t("ticking an already-paid gig does not double-log", () => {
  const db = moneyDB(); T.setDB(db);
  T.toggleGigPaid("g1", true);
  const n = db.income.length;
  T.toggleGigPaid("g1", true);
  eq(db.income.length, n, "nothing outstanding, so nothing added");
});

t("a cancelled gig is not money you are owed", () => {
  const db = moneyDB(); T.setDB(db);
  db.gigs.push({ id: "g5", title: "Called off", date: "2026-08-09", clientId: "c1",
                 rateType: "flat", rate: 999, status: "cancelled" });
  T.setDB(db);
  const live = T.workGigs();
  eq(live.length, 4, "the cancelled gig is dropped from the work list");
  eq(T.owedTotals(live).total, 1250, "so its fee is excluded");
});

/* ================= personal events =================
   The whole reason these live in their own array: a birthday must never turn into
   money owed, a fee, or a line in a month's projection. */

t("a personal event is not a gig and never reaches the money", () => {
  const db = T.defaultData();
  db.clients = [{ id: "c1", name: "A Client" }];
  db.gigs = [{ id: "g1", title: "Real gig", date: "2026-09-04", clientId: "c1",
               rateType: "flat", rate: 400 }];
  db.personal = [{ id: "p1", title: "Mum's birthday", date: "2026-09-04", kind: "Birthday" },
                 { id: "p2", title: "Vegas trip", date: "2026-09-12", kind: "Trip" }];
  db.income = []; db.expenses = [];
  T.setDB(db);

  const live = T.workGigs();
  eq(live.length, 1, "personal events must not be counted as work");
  eq(T.owedTotals(live).total, 400, "only the gig is owed");
  const m = T.moneyByMonth(live)["2026-09"];
  eq(m.upcoming, 400, "the birthday adds nothing to owed");
  eq(m.tbd, 0, "and is not counted as a gig with no rate");
  eq(T.ytdFigures().earned, 0, "nothing earned from a personal event");
});

t("personal events are stored apart from gigs", () => {
  const db = T.defaultData();
  db.gigs = []; db.personal = [];
  T.setDB(db);
  T.setState({ view: "calendar" });
  // what the form writes
  db.personal.push({ id: "p1", title: "Dentist", date: "2026-09-20", kind: "Appointment" });
  eq(db.gigs.length, 0, "must not land in gigs");
  eq(T.personalById("p1").title, "Dentist");
  eq(T.personalById("nope"), undefined, "unknown id");
});

t("a personal event carries no money fields at all", () => {
  const db = T.defaultData();
  db.personal = [{ id: "p1", title: "Trip", date: "2026-09-20", kind: "Trip" }];
  db.gigs = []; T.setDB(db);
  const e = db.personal[0];
  ["rate", "rateType", "clientId", "invoiceId", "hours"].forEach((k) => {
    if (k in e) throw new Error("personal event has a money field: " + k);
  });
  // and gigValue would read it as worthless rather than as a fee
  eq(T.gigValue(e), 0);
});

t("the sync knows how to store them", () => {
  // A record type the sync does not know about is silently dropped on save.
  const cloudSrc = read("cloud.js");
  if (!/p:\s*"personal"/.test(cloudSrc)) {
    throw new Error("RECORD_TYPES has no prefix for personal — they would not sync");
  }
});

/* ================= multi-day personal events ================= */

t("a one-day event covers exactly one day", () => {
  T.setDB(T.defaultData());
  eq(JSON.stringify(T.personalDays({ date: "2026-09-12" })), JSON.stringify(["2026-09-12"]));
  eq(JSON.stringify(T.personalDays({ date: "2026-09-12", endDate: "" })),
     JSON.stringify(["2026-09-12"]));
  eq(T.spanLabel({ date: "2026-09-12" }), "", "no range to show");
});

t("a trip covers every day from start to end, inclusive", () => {
  T.setDB(T.defaultData());
  const days = T.personalDays({ date: "2026-09-20", endDate: "2026-09-24" });
  eq(days.length, 5, "20th through 24th is five days");
  eq(days[0], "2026-09-20");
  eq(days[4], "2026-09-24");
});

t("a span crossing a month boundary still works", () => {
  T.setDB(T.defaultData());
  const days = T.personalDays({ date: "2026-09-29", endDate: "2026-10-02" });
  eq(JSON.stringify(days),
     JSON.stringify(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]));
});

t("a leap day is not skipped", () => {
  T.setDB(T.defaultData());
  const days = T.personalDays({ date: "2028-02-27", endDate: "2028-03-01" });
  if (days.indexOf("2028-02-29") < 0) throw new Error("2028 is a leap year: " + days.join(","));
  eq(days.length, 4);
});

t("an end before the start cannot produce a range that renders nowhere", () => {
  T.setDB(T.defaultData());
  // personalDays must never return an empty list, whatever it is handed
  eq(T.personalDays({ date: "2026-09-20", endDate: "2026-09-10" }).length, 1,
     "a backwards range falls back to the single start day");
});

t("a mistyped year cannot spin forever", () => {
  T.setDB(T.defaultData());
  const days = T.personalDays({ date: "2026-09-01", endDate: "2126-09-01" });
  if (days.length > 401) throw new Error("unbounded: " + days.length);
});

t("the span label reads as a range only when there is one", () => {
  T.setDB(T.defaultData());
  const l = T.spanLabel({ date: "2026-09-20", endDate: "2026-09-24" });
  if (l.indexOf("–") < 0) throw new Error("expected a range, got: " + l);
  eq(T.spanLabel({ date: "2026-09-20", endDate: "2026-09-20" }), "",
     "same day both ends is not a range");
});

/* ---------- the game: XP, levels, streak ---------- */

const doneOn = (id, day, xp) => ({ id: id, text: id, done: true, doneAt: day, xp: xp });

t("XP adds up finished tasks, 20 each unless set", () => {
  const db = T.defaultData();
  db.todos = [doneOn("a", "2026-09-01"), doneOn("b", "2026-09-01", 35),
              { id: "c", text: "c", done: false, xp: 100 }];
  T.setDB(db);
  eq(T.gameStats().totalXP, 55, "open tasks earn nothing yet");
});

t("a level costs XP_PER_LEVEL, and the bar restarts at each level", () => {
  const db = T.defaultData();
  db.todos = [doneOn("a", "2026-09-01", T.XP_PER_LEVEL - 10)];
  T.setDB(db);
  eq(T.gameStats().level, 1, "just short");
  db.todos.push(doneOn("b", "2026-09-02", 30));
  const g = T.gameStats();
  eq(g.level, 2, "over the line");
  eq(g.xpIntoLevel, 20, "carry-over into the new level");
});

t("streak counts consecutive days and resets after a missed one", () => {
  const days = new Set(["2026-09-28", "2026-09-29", "2026-09-30"]);
  eq(T.streakFrom(days, "2026-09-30T12:00:00"), 3, "done today");
  eq(T.streakFrom(days, "2026-10-01T09:00:00"), 3, "today not over yet: yesterday's run holds");
  eq(T.streakFrom(days, "2026-10-02T09:00:00"), 0, "a whole day missed");
  eq(T.streakFrom(new Set(["2026-09-28", "2026-09-30"]), "2026-09-30T12:00:00"), 1, "gap breaks it");
});

t("deleting a finished task keeps its XP and its streak day", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [doneOn("a", "2026-09-01", 40), { id: "b", text: "b", done: false }];
  T.setDB(db);
  T.bankXP(db.todos);
  db.todos = db.todos.filter((x) => !x.done);
  eq(T.gameStats().totalXP, 40, "XP survives the delete");
  eq(db.game.bankedDays.join(), "2026-09-01", "the day is kept for the streak");
});

t("old data with no game section loads with an empty one", () => {
  const db = T.withDefaults({ settings: {} });
  eq(db.game.bankedXP, 0);
  eq(Array.isArray(db.game.bankedDays), true, "bankedDays is a list");
});

/* ---------- the battle, the hero, the playbook ---------- */

t("the slime's health is today's quest XP, and finishing them all wins", () => {
  const db = T.withDefaults(T.defaultData());
  const today = T.isoOf(new Date());
  db.todos = [
    { id: "a", text: "a", done: false, top: true, topRank: 0, prio: "urgent", stat: "craft" },
    { id: "b", text: "b", done: true, doneAt: today, stat: "craft" },
    { id: "c", text: "c", done: true, doneAt: "2020-01-01" },     // an old win doesn't count
  ];
  T.setDB(db);
  let b = T.battleState(T.todaysQuests());
  eq(b.maxHP, 70, "50 for the urgent open quest + 20 done today");
  eq(b.hp, 50, "only the open quest is left");
  eq(b.won, false);
  db.todos[0].done = true; db.todos[0].doneAt = today; db.todos[0].top = false;
  b = T.battleState(T.todaysQuests());
  eq(b.hp, 0); eq(b.won, true, "all done today");
});

t("with no quests the slime is asleep, not beaten", () => {
  const db = T.withDefaults(T.defaultData());
  T.setDB(db);
  const b = T.battleState(T.todaysQuests());
  eq(b.asleep, true); eq(b.won, false);
});

t("a hero with nothing saved gets the defaults, and saved picks survive", () => {
  const db = T.withDefaults(T.defaultData());
  T.setDB(db);
  eq(T.heroOf().weapon, "sword");
  db.game.hero = { weapon: "staff", outfit: 3 };
  const h = T.heroOf();
  eq(h.weapon, "staff"); eq(h.outfit, 3); eq(h.hat, "none", "unsaved fields fall back");
  if (!T.HERO_OPTIONS.outfit[h.outfit]) throw new Error("outfit index out of range");
});

t("the monster of the day is stable for a given date", () => {
  eq(T.mobOfDay("2026-10-01").name, T.mobOfDay("2026-10-01").name);
});

t("every monster sprite is a clean rectangle with eyes, and every monster has one", () => {
  Object.keys(T.MOB_SPRITES).forEach((k) => {
    const rows = T.MOB_SPRITES[k];
    rows.forEach((r, i) => { if (r.length !== rows[0].length) throw new Error(k + " row " + i + " is the wrong width"); });
    if (rows.join("").indexOf("E") < 0) throw new Error(k + " has no eyes");
  });
  T.MOBS.forEach((m) => {
    if (!T.MOB_SPRITES[m.sprite]) throw new Error(m.name + " has no sprite");
    if (T.mobSVG(m).indexOf("undefined") >= 0) throw new Error(m.name + " uses a colour it doesn't define");
  });
  eq(T.HERO_OPTIONS.slime.length, T.MOBS.length + 1, "every monster can be picked, plus 'changes daily'");
});

t("every playbook tip has a real source link, an evidence rating and a quest", () => {
  const ids = new Set();
  T.PLAYBOOK.forEach((p) => {
    if (ids.has(p.id)) throw new Error("duplicate id " + p.id);
    ids.add(p.id);
    if (!/^https:\/\//.test(p.src[1])) throw new Error(p.id + ": source is not an https link");
    if (!T.EVIDENCE[p.evidence]) throw new Error(p.id + ": unknown evidence level " + p.evidence);
    if (!p.quest || !p.what || !p.why) throw new Error(p.id + ": missing text");
  });
});

t("a picked monster sticks; 'changes daily' follows the date", () => {
  eq(T.mobFor({ slime: 3 }, "2026-10-01").name, T.MOBS[2].name, "option 3 is the third monster");
  eq(T.mobFor({ slime: 0 }, "2026-10-01").name, T.mobOfDay("2026-10-01").name, "0 is daily");
  eq(T.mobFor({}, "2026-10-01").name, T.mobOfDay("2026-10-01").name, "unset is daily");
});

t("a quest finished today leaves the quest list but still counts", () => {
  const db = T.withDefaults(T.defaultData());
  db.settings.yourName = "Test Person"; db.settings.email = "t@example.test";
  const today = T.isoOf(new Date());
  db.todos = [
    { id: "a", text: "Still to do", done: false, top: true, topRank: 0 },
    { id: "b", text: "Finished earlier", done: true, doneAt: today },
  ];
  T.setDB(db);
  T.setState({ view: "today", showDone: false });
  const html = T.VIEWS.today();
  if (html.indexOf("Finished earlier") >= 0) throw new Error("finished quest still on screen");
  if (html.indexOf("Still to do") < 0) throw new Error("open quest missing");
  if (html.indexOf("1 of 2 done") < 0) throw new Error("counter should still read 1 of 2 done");
});

t("the update log is newest first and every entry says what was asked and what changed", () => {
  T.CHANGELOG.forEach((e, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error("bad date: " + e.date);
    if (!e.asked || !e.changed.length || !e.title) throw new Error("incomplete entry: " + e.title);
    if (i && e.date > T.CHANGELOG[i - 1].date) throw new Error("out of order: " + e.title);
  });
});

const slots = () => T.getDB().todos.filter((x) => x.top && !x.done)
  .sort((a, b) => a.topRank - b.topRank).map((x) => x.id + "@" + x.topRank).join(" ");

t("dragging one of today's quests onto another swaps them", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [{ id: "a", text: "a", top: true, topRank: 0 }, { id: "b", text: "b", top: true, topRank: 1 },
              { id: "c", text: "c", top: false, topRank: null }];
  T.setDB(db); T.setState({ view: "calendar" });
  T.assignTop("b", 0);
  eq(slots(), "b@0 a@1", "b takes up next, a moves to b's old place");
});

t("a task from the quest log nudges the occupant into a free slot", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [{ id: "a", text: "a", top: true, topRank: 0 }, { id: "c", text: "c", top: false, topRank: null }];
  T.setDB(db); T.setState({ view: "calendar" });
  T.assignTop("c", 0);
  eq(slots(), "c@0 a@1", "a is kept, not sent back to the log");
});

t("only with all three slots full does the occupant go back to the log", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [{ id: "a", text: "a", top: true, topRank: 0 }, { id: "b", text: "b", top: true, topRank: 1 },
              { id: "d", text: "d", top: true, topRank: 2 }, { id: "c", text: "c", top: false, topRank: null }];
  T.setDB(db); T.setState({ view: "calendar" });
  T.assignTop("c", 1);
  eq(slots(), "a@0 c@1 d@2");
  eq(db.todos.find((x) => x.id === "b").top, false, "b returns to the log");
});

/* ---------- the five stats ---------- */

const dayAgo = (n) => T.addDays(T.isoOf(new Date()), -n);
const never = () => 0.99;     // an rng that never drops bonus loot

t("XP comes from priority: booked 10, regular 25, urgent 50", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [{ id: "a", text: "a", stat: "mind", prio: "booked" },
              { id: "b", text: "b", stat: "mind" },
              { id: "c", text: "c", stat: "mind", prio: "urgent", xp: 999 }];   // an old XP number is ignored
  T.setDB(db);
  const sh = T.statSheet();
  eq(db.todos.map((x) => T.previewXP(x, sh)).join(), "10,25,50");
});

t("the multiplier climbs with no cap, but each step takes longer", () => {
  eq(T.streakMult(1), 1); eq(T.streakMult(2), 1.25); eq(T.streakMult(4), 1.5); eq(T.streakMult(16), 2);
  for (let d = 1; d < 400; d++) {
    if (!(T.streakMult(d + 1) > T.streakMult(d))) throw new Error("stopped climbing at day " + d);
    if (d > 1 && T.streakMult(d + 1) - T.streakMult(d) > T.streakMult(d) - T.streakMult(d - 1) + 1e-12)
      throw new Error("sped up at day " + d);
  }
  if (!(T.streakMult(5000) > T.streakMult(1000))) throw new Error("capped");
});

t("a stat levels up at 100 XP, then 50 more each level", () => {
  eq(T.statLevel(99).level, 1);
  const l2 = T.statLevel(100);
  eq(l2.level, 2); eq(l2.into, 0); eq(l2.need, 150);
  eq(T.statLevel(250).level, 3, "100 + 150");
});

t("each stat keeps its own streak; missing a day resets only that one", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [doneOn("c1", "2026-09-28"), doneOn("c2", "2026-09-29"), doneOn("c3", "2026-09-30"),
              doneOn("h1", "2026-09-29")];
  db.todos.forEach((x) => { x.stat = x.id[0] === "c" ? "craft" : "hustle"; });
  T.setDB(db);
  let sh = T.statSheet("2026-09-30T12:00:00");
  eq(sh.craft.streak, 3); eq(sh.hustle.streak, 1, "hustle's run is alive until today ends");
  sh = T.statSheet("2026-10-01T09:00:00");
  eq(sh.craft.streak, 3, "craft untouched by hustle's miss");
  eq(sh.hustle.streak, 0, "hustle missed 9/30 and reset");
  eq(sh.mind.streak, 0, "a stat never used has no streak");
});

t("ticking off stamps the XP at that stat's multiplier, and it never shrinks later", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [doneOn("y2", dayAgo(2)), doneOn("y1", dayAgo(1)), doneOn("v", dayAgo(1)),
              { id: "n", text: "Reply to the client", prio: "urgent", stat: "craft", done: true, doneAt: dayAgo(0) }];
  db.todos[0].stat = db.todos[1].stat = "craft";
  db.todos[2].stat = "vitality";
  T.setDB(db);
  T.awardTask(db.todos[3], never);
  const want = Math.round(50 * T.streakMult(3));
  eq(db.todos[3].earned.xp, want, "urgent 50 on a 3-day craft streak");
  eq(T.statSheet().vitality.xp, 20, "vitality's legacy task is untouched");
  db.todos = db.todos.filter((x) => x.id === "n");        // the streak behind it disappears
  eq(T.earnedXP(db.todos[0]), want, "stamped, so it doesn't shrink");
});

t("a streak milestone always drops its badge, once per run", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [doneOn("a", dayAgo(2)), doneOn("b", dayAgo(1)),
              { id: "n", text: "n", stat: "craft", done: true, doneAt: dayAgo(0) }];
  db.todos[0].stat = db.todos[1].stat = "craft";
  T.setDB(db);
  let drops = T.awardTask(db.todos[2], never);
  eq(drops.map((d) => d.item.id).join(), "badge-craft-3", "day 3 pays out");
  eq(db.game.loot.owned["badge-craft-3"].n, 1);
  // Un-tick and re-tick: same run, so no second badge, and no second bonus roll.
  db.todos[2].done = false; delete db.todos[2].earned;
  db.todos[2].done = true; db.todos[2].doneAt = dayAgo(0);
  drops = T.awardTask(db.todos[2], () => 0);
  eq(drops.length, 0, "nothing new: badge already paid for this run, and the task already rolled");
});

t("a 30-day streak pays every badge up to it, plus the stat's title", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [];
  for (let i = 29; i >= 1; i--) db.todos.push(Object.assign(doneOn("d" + i, dayAgo(i)), { stat: "hustle" }));
  const n = { id: "n", text: "n", stat: "hustle", done: true, doneAt: dayAgo(0) };
  db.todos.push(n);
  T.setDB(db);
  const ids = T.awardTask(n, never).map((d) => d.item.id);
  eq(ids.join(), "badge-hustle-3,badge-hustle-7,badge-hustle-14,badge-hustle-30,st-hustle-30");
  eq(T.lootItem("st-hustle-30").kind, "title");
});

t("bonus loot drops about 8% of the time, only unfound items, then XP chests", () => {
  const db = T.withDefaults(T.defaultData());
  T.setDB(db);
  let seed = 12345;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let hits = 0;
  for (let i = 0; i < 20000; i++) if (T.rollLoot(rng)) hits++;
  const rate = hits / 20000;
  if (rate < 0.06 || rate > 0.10) throw new Error("drop rate " + rate);
  if (T.LOOT_CHANCE < 0.05 || T.LOOT_CHANCE > 0.10) throw new Error("chance outside 5-10%");
  eq(T.rollLoot(() => 0.5), null, "a miss");
  db.game.loot.owned = {};
  T.LOOT.slice(1).forEach((x) => { db.game.loot.owned[x.id] = { n: 1 }; });
  eq(T.rollLoot(() => 0.01).id, T.LOOT[0].id, "only the one not yet found can drop");
  db.game.loot.owned[T.LOOT[0].id] = { n: 1 };
  eq(T.rollLoot(() => 0.01).kind, "chest", "everything found: XP instead");
});

t("a chest pays its XP into the task's stat", () => {
  const db = T.withDefaults(T.defaultData());
  T.LOOT.forEach((x) => { db.game.loot.owned[x.id] = { n: 1 }; });
  db.todos = [{ id: "n", text: "n", stat: "empire", done: true, doneAt: dayAgo(0) }];
  T.setDB(db);
  const drops = T.awardTask(db.todos[0], () => 0.01);
  eq(drops[0].item.kind, "chest");
  eq(T.statSheet().empire.xp, 50 + 25, "the chest plus the task itself");
  eq(T.statSheet().craft.xp, 0, "and nowhere else");
});

t("deleting a finished task keeps its XP and streak day in its stat", () => {
  const db = T.withDefaults(T.defaultData());
  db.todos = [Object.assign(doneOn("a", "2026-09-01", 40), { stat: "mind" })];
  T.setDB(db);
  T.bankXP(db.todos);
  db.todos = [];
  const sh = T.statSheet();
  eq(sh.mind.xp, 40); eq(sh.mind.days.has("2026-09-01"), true);
  eq(sh.craft.xp, 0, "nothing leaks into other stats");
});

t("older tasks get a stat from their words, then their category", () => {
  eq(T.guessStat({ text: "List the jacket on eBay" }), "hustle");
  eq(T.guessStat({ text: "Edit the wedding gallery" }), "craft");
  eq(T.guessStat({ text: "Update the Lightroom presets on Gumroad" }), "empire", "two empire words beat one craft word");
  eq(T.guessStat({ text: "Gym before lunch" }), "vitality");
  eq(T.guessStat({ text: "Get ready for taxes" }), "mind", "'ready' doesn't count as 'read'");
  eq(T.guessStat({ text: "Call back", category: "Admin" }), "mind", "category when no words match");
  eq(T.guessStat({ text: "Call back" }), "craft", "and photo work when nothing does");
  eq(T.statOf({ stat: "empire", text: "gym" }), "empire", "a picked stat always wins");
  eq(T.prioOf({ category: "Shoot" }), "booked");
  eq(T.prioOf({ category: "Client" }), "urgent");
  eq(T.prioOf({}), "regular");
  eq(T.prioOf({ prio: "booked", category: "Urgent" }), "booked", "a picked priority always wins");
});

t("old saves gain the stats and loot without losing anything", () => {
  const db = T.withDefaults({ settings: {}, game: { bankedXP: 40, bankedDays: ["2026-09-01"], hero: { weapon: "staff" } } });
  eq(db.game.bankedXP, 40); eq(db.game.hero.weapon, "staff");
  eq(typeof db.game.statBank, "object");
  eq(Array.isArray(db.game.loot.runs), true);
  eq(typeof db.game.loot.owned, "object");
});

t("Today shows all five stats; Personal lets you wear only loot you've found", () => {
  const db = T.withDefaults(T.defaultData());
  db.settings.yourName = "Test Person"; db.settings.email = "t@example.test";
  db.todos = [{ id: "a", text: "Ship the jacket", stat: "hustle" }];
  db.game.loot.owned["t-inbox"] = { n: 1 };
  db.game.loot.equip.title = "t-inbox";
  T.setDB(db);
  T.setState({ view: "today", showDone: false });
  const today = T.VIEWS.today();
  T.STATS.forEach((s) => { if (today.indexOf('data-stat="' + s.id + '"') < 0) throw new Error("no tile for " + s.name); });
  T.setState({ view: "personal" });
  const p = T.VIEWS.personal();
  if (p.indexOf('data-act="loot-equip" data-kind="title" data-id="t-inbox"') < 0) throw new Error("found title can't be worn");
  if (p.indexOf('data-id="t-maincharacter"') >= 0) throw new Error("an unfound title can be worn");
  if (p.indexOf("Main Character") < 0) throw new Error("unfound titles should be listed to find");
  if (p.indexOf("A 30-day Hustle streak") < 0) throw new Error("streak medals should say how to earn them");
  eq(T.heroTitle(), "Inbox Slayer");
  db.game.loot.equip.title = "t-maincharacter";
  eq(T.heroTitle(), "", "a title you don't own can't be worn");
});

/* ---------- the real MapleStory character ---------- */

t("a hero with nothing saved is a Beginner in real game items", () => {
  eq(T.avatarItems(T.avatarOf({})).join(), "2000,12000,20000,30000,1040002,1060002,1072001,1302000");
});

t("an old pixel hero keeps their skin, hair colour and weapon", () => {
  const a = T.avatarOf({ skin: 4, hairColor: 2, hairStyle: "spiky", weapon: "staff" });
  eq(a.skin, 2002, "deep skin to dark"); eq(a.hair, 30033, "spiky, blonde"); eq(a.gear.Weapon, 1382000, "a staff");
});

t("a saved outfit is used exactly as saved", () => {
  const a = T.avatarOf({ weapon: "axe", avatar: { skin: 2001, face: 21000, hair: 31005, gear: { Hat: 1002080 } } });
  eq(a.gear.Hat, 1002080); eq(a.gear.Weapon, undefined, "old fields don't leak into a saved outfit");
  eq(T.avatarItems(a).slice(0, 4).join(), "2001,12001,21000,31005", "head matches the skin");
});

t("an overall replaces the top and bottom, and a top replaces an overall", () => {
  const d = { gear: { Top: 1040002, Bottom: 1060002 } };
  T.closetWear(d, "Overall", 1052000);
  eq(Object.keys(d.gear).join(), "Overall");
  T.closetWear(d, "Top", 1040002);
  eq(Object.keys(d.gear).join(), "Top");
  T.closetWear(d, "Top", null);
  eq(Object.keys(d.gear).length, 0, "taking it off empties the slot");
});

t("the render address lists every item on one fixed canvas", () => {
  const a = T.avatarOf({});
  const url = decodeURIComponent(T.avatarURL(a, "stand1"));
  T.avatarItems(a).forEach((id) => { if (url.indexOf('"itemId":' + id + ",") < 0) throw new Error("missing item " + id); });
  if (url.indexOf("/stand1/animated?renderMode=1") < 0) throw new Error("wrong pose or canvas: " + url.slice(-40));
  if (decodeURIComponent(T.avatarURL(a, "swingO1", 2)).indexOf("/swingO1/2?") < 0) throw new Error("frame not used");
});

t("two-handed weapons stand and swing two-handed; bows shoot", () => {
  eq(T.weaponActions(1402039).stand, "stand2"); eq(T.weaponActions(1402039).attack, "swingT1");
  eq(T.weaponActions(1302000).attack, "swingO1");
  eq(T.weaponActions(1452002).attack, "shoot1");
  eq(T.weaponActions(undefined).stand, "stand1", "bare hands");
});

t("the closet lists each hair and face once, whatever its colour", () => {
  eq(T.closetBase("Hair", 30035), 30030); eq(T.closetBase("Face", 20312), 20012);
  eq(T.closetBase("Hat", 1002080), 1002080, "gear is never folded");
  eq(T.closetName("Hair", "Blue Metro"), "Metro");
  eq(T.closetName("Face", "Motivated Look (Black)"), "Motivated Look");
});

t("every monster carries the game's own id, once", () => {
  const ids = new Set();
  T.MOBS.forEach((m) => {
    if (!(m.id > 0)) throw new Error(m.name + " has no id");
    if (ids.has(m.id)) throw new Error("duplicate id " + m.id);
    ids.add(m.id);
  });
  eq(T.MOBS[6].name, "Stump", "picks are saved by position, so the first eight keep their places");
});

/* ---------- bosses, rewards, the world map ---------- */

t("a boss falls on its last step, once, with a guaranteed drop", () => {
  const db = T.withDefaults(T.defaultData());
  db.game.bosses = [{ id: "b1", name: "Portfolio relaunch", look: 2220000, defeatedAt: null, paid: false, cleared: 0 }];
  db.todos = [{ id: "s1", text: "Pick shots", boss: "b1", stat: "craft", done: true, doneAt: dayAgo(1), earned: { xp: 25 }, rolled: true },
              { id: "s2", text: "Rewrite about", boss: "b1", stat: "craft", done: false }];
  T.setDB(db);
  let pr = T.bossProgress(db.game.bosses[0]);
  eq(pr.total, 2); eq(pr.left, 1); eq(pr.next.id, "s2");
  const s2 = db.todos[1]; s2.done = true; s2.doneAt = dayAgo(0);
  const drops = T.awardTask(s2, never);
  eq(drops.filter((d) => d.item.kind === "boss").length, 1, "the boss celebration");
  if (drops.filter((d) => d.item.kind !== "boss" && d.item.kind !== "badge").length !== 1) throw new Error("no guaranteed bonus drop");
  eq(db.game.bosses[0].defeatedAt, dayAgo(0));
  s2.done = false; db.game.bosses[0].defeatedAt = null;        // un-ticked: back on its feet
  s2.done = true;
  eq(T.awardTask(s2, never).filter((d) => d.item.kind === "boss").length, 0, "paid once only");
});

t("deleting a finished boss step still counts as a hit", () => {
  const db = T.withDefaults(T.defaultData());
  db.game.bosses = [{ id: "b1", name: "B", look: 1, cleared: 0 }];
  db.todos = [{ id: "s1", text: "a", boss: "b1", done: true, doneAt: "2026-09-01" }, { id: "s2", text: "b", boss: "b1", done: false }];
  T.setDB(db);
  T.bankXP(db.todos.filter((x) => x.done));
  db.todos = db.todos.filter((x) => !x.done);
  const pr = T.bossProgress(db.game.bosses[0]);
  eq(pr.total, 2); eq(pr.done, 1);
});

t("a reward counts quests from the day it was set, not before", () => {
  const db = T.withDefaults(T.defaultData());
  db.game.reward = { name: "Sushi night", icon: "🍣", cost: 3, since: dayAgo(0), base: 1, banked: 0 };
  db.todos = [{ id: "a", done: true, doneAt: dayAgo(1) }, { id: "b", done: true, doneAt: dayAgo(0) },
              { id: "c", done: true, doneAt: dayAgo(0) }];
  T.setDB(db);
  let pr = T.rewardProgress();
  eq(pr.have, 1, "yesterday's doesn't count, and b was done before the reward was set");
  db.todos.push({ id: "d", done: true, doneAt: dayAgo(0) }, { id: "e", done: true, doneAt: dayAgo(0) });
  pr = T.rewardProgress();
  eq(pr.have, 3); eq(pr.ready, true);
});

t("towns open by hero level, or early as loot; Henesys is always open", () => {
  const db = T.withDefaults(T.defaultData());
  T.setDB(db);
  eq(T.mapOpen("", 1), true);
  eq(T.mapOpen("bg-dots", 1), false, "Ellinia is Lv.3");
  eq(T.mapOpen("bg-dots", 3), true);
  eq(T.mapOpen("map-mulung", 20), false);
  db.game.loot.owned["map-mulung"] = { n: 1 };
  eq(T.mapOpen("map-mulung", 1), true, "found as loot");
  eq(T.mapOpen("not-a-town", 99), false);
  const ids = new Set();
  T.WORLD.forEach((m, i) => {
    if (ids.has(m.id)) throw new Error("duplicate town " + m.name);
    ids.add(m.id);
    if (i && m.level < T.WORLD[i - 1].level) throw new Error("towns out of level order at " + m.name);
  });
});

t("the stat key covers every stat", () => {
  T.STATS.forEach((x) => {
    if (!T.STAT_GUIDE[x.id] || !T.STAT_GUIDE[x.id].examples) throw new Error("no guide for " + x.name);
    if (!T.STAT_WORDS[x.id].length) throw new Error("no Auto words for " + x.name);
  });
});

/* ---------- report ---------- */
Promise.all(pending).then(() => {
  console.log("");
  failures.forEach((f) => console.log("  FAIL  " + f));
  console.log("");
  console.log((fail ? "FAILED" : "PASSED") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
});
