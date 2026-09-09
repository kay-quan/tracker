/* ============================================================
   Cloud storage — Firebase Auth + Firestore, over plain REST.

   No SDK and no build step: the whole tracker stays dependency-free.
   Each record is its own Firestore document under trackers/{uid}/, which only
   your signed-in account can read or write. See the data section for why it is
   one document per record rather than one document for everything.
   ============================================================ */

const FB_CONFIG = {
  apiKey: "AIzaSyBYcqJmTZgicJEcD5buz8ry0oTaCUrb7AQ",
  authDomain: "kq-life.firebaseapp.com",
  projectId: "kq-life",
};

const AUTH_KEY = "kq-tracker-auth";
const IDENTITY = "https://identitytoolkit.googleapis.com/v1/accounts";
const SECURETOKEN = "https://securetoken.googleapis.com/v1/token";
const FIRESTORE = "https://firestore.googleapis.com/v1/projects/" +
  FB_CONFIG.projectId + "/databases/(default)/documents";

const Cloud = {
  session: null,   // { idToken, refreshToken, expiresAt, uid, email }

  /* ---------- session ---------- */

  restore() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) this.session = JSON.parse(raw);
    } catch (err) {
      this.session = null;
    }
    return this.session;
  },

  persist() {
    try {
      if (this.session) localStorage.setItem(AUTH_KEY, JSON.stringify(this.session));
      else localStorage.removeItem(AUTH_KEY);
    } catch (err) {
      /* private browsing can refuse storage; the session just won't survive a reload */
    }
  },

  signedIn() { return !!(this.session && this.session.refreshToken); },

  async signIn(email, password) {
    const res = await fetch(IDENTITY + ":signInWithPassword?key=" + FB_CONFIG.apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password, returnSecureToken: true }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(friendlyAuthError(out));
    this.session = {
      idToken: out.idToken,
      refreshToken: out.refreshToken,
      expiresAt: Date.now() + Number(out.expiresIn || 3600) * 1000,
      uid: out.localId,
      email: out.email,
    };
    this.persist();
    return this.session;
  },

  signOut() {
    this.session = null;
    // The diff baseline belongs to the account that just left. Keeping it would let
    // the next person signed in on this device write their records over that account's.
    this.lastPush = null;
    this.persist();
  },

  // Firebase ID tokens last an hour; swap in a fresh one before it lapses.
  async token() {
    if (!this.session) throw new Error("Not signed in.");
    if (Date.now() < this.session.expiresAt - 5 * 60 * 1000) return this.session.idToken;

    const res = await fetch(SECURETOKEN + "?key=" + FB_CONFIG.apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(this.session.refreshToken),
    });
    const out = await res.json();
    if (!res.ok) {
      this.signOut();                       // refresh token revoked or expired
      throw new Error("Your session expired. Please sign in again.");
    }
    this.session.idToken = out.id_token;
    this.session.refreshToken = out.refresh_token;
    this.session.expiresAt = Date.now() + Number(out.expires_in || 3600) * 1000;
    this.persist();
    return this.session.idToken;
  },

  /* ---------- data ----------
     One document per record, not one document for everything.

     The old model wrote the entire tracker as a single JSON blob. Whoever saved last
     won, wholesale: a phone holding a copy from an hour ago would overwrite an evening
     of edits made on the laptop, because it wrote back every field it knew about. It
     had also grown to 241 KB against a 1 MB per-document ceiling.

     Now each gig, invoice, client, outreach row and to-do is its own document under
     trackers/{uid}/rec/, keyed <type>.<id>, and a save writes ONLY what changed. Two
     devices editing different records no longer collide at all.

     Two things deliberately stay whole documents:
       ref/events  - local events are derived from the Edmtrain feed and replaced
                     wholesale on every refresh. 462 of them as separate documents
                     would mean ~470 reads on every page load to rebuild data that
                     is thrown away and refetched anyway.
       ref/meta    - settings and scalars. One small object, always read together. */

  DOCROOT: "projects/" + FB_CONFIG.projectId + "/databases/(default)/documents",

  // prefix -> the DB array it belongs to
  RECORD_TYPES: { g: "gigs", i: "invoices", n: "income", x: "expenses",
                  c: "clients", o: "outreach", t: "todos" },

  legacyUrl() { return FIRESTORE + "/trackers/" + this.session.uid; },
  recCollUrl() { return FIRESTORE + "/trackers/" + this.session.uid + "/rec"; },

  lastPush: null,       // key -> JSON string, as last written. The diff baseline.

  /* Flatten state into the documents that represent it. Same shape on read and
     write, so the diff is a plain string comparison. */
  _explode(data) {
    const docs = {};
    const meta = {};
    Object.keys(data).forEach((k) => {
      if (k === "localEvents") return;
      if (Object.values(this.RECORD_TYPES).indexOf(k) >= 0) return;
      meta[k] = data[k];
    });
    docs["ref/meta"] = JSON.stringify(meta);
    docs["ref/events"] = JSON.stringify({ rows: data.localEvents || [] });
    Object.keys(this.RECORD_TYPES).forEach((p) => {
      (data[this.RECORD_TYPES[p]] || []).forEach((r) => {
        if (r && r.id) docs["rec/" + p + "." + r.id] = JSON.stringify(r);
      });
    });
    return docs;
  },

  async _commit(writes) {
    if (!writes.length) return;
    const token = await this.token();
    // Firestore caps a commit at 500 writes; stay well under it.
    for (let i = 0; i < writes.length; i += 400) {
      const res = await fetch(FIRESTORE + ":commit", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ writes: writes.slice(i, i + 400) }),
      });
      if (!res.ok) throw new Error(await describeError(res));
    }
  },

  async _readColl(path) {
    const token = await this.token();
    const out = [];
    let url = path + "?pageSize=300";
    for (let guard = 0; url && guard < 60; guard++) {
      const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (res.status === 404) break;
      if (!res.ok) throw new Error(await describeError(res));
      const page = await res.json();
      (page.documents || []).forEach((d) => out.push(d));
      url = page.nextPageToken
        ? path + "?pageSize=300&pageToken=" + encodeURIComponent(page.nextPageToken)
        : null;
    }
    return out;
  },

  async load() {
    const meta = await this.loadRef("meta");

    // Nothing in the new layout yet: either a first run, or a tracker still on the
    // single-blob model. Migrating reads the old document and writes the new one.
    if (!meta) {
      const migrated = await this._migrate();
      if (migrated) return migrated;
      return null;
    }

    const data = meta.data || {};
    Object.keys(this.RECORD_TYPES).forEach((p) => { data[this.RECORD_TYPES[p]] = []; });

    const docs = await this._readColl(this.recCollUrl());
    docs.forEach((d) => {
      const key = d.name.split("/").pop();
      const list = this.RECORD_TYPES[key.split(".")[0]];
      const raw = d.fields && d.fields.json && d.fields.json.stringValue;
      if (!list || !raw) return;
      try { data[list].push(JSON.parse(raw)); } catch (err) { /* skip a corrupt row */ }
    });

    const ev = await this.loadRef("events");
    data.localEvents = (ev && ev.data && ev.data.rows) || [];

    this.lastPush = this._explode(data);
    return data;
  },

  /* One-way move off the single blob. The old document is left exactly where it is:
     it costs nothing, and it is the rollback if anything here is wrong. */
  async _migrate() {
    const token = await this.token();
    const res = await fetch(this.legacyUrl(), { headers: { Authorization: "Bearer " + token } });
    if (res.status === 404) return null;                 // genuinely a first run
    if (!res.ok) throw new Error(await describeError(res));
    const out = await res.json();
    const raw = out.fields && out.fields.json && out.fields.json.stringValue;
    if (!raw) return null;

    const data = JSON.parse(raw);
    const docs = this._explode(data);
    await this._commit(Object.keys(docs).map((k) => this._write(k, docs[k])));
    this.lastPush = docs;
    return data;
  },

  _write(key, json) {
    return {
      update: {
        name: this.DOCROOT + "/trackers/" + this.session.uid + "/" + key,
        fields: { json: { stringValue: json }, t: { integerValue: String(Date.now()) } },
      },
    };
  },

  async save(data) {
    const next = this._explode(data);

    // No baseline (a save before any load completed): write everything once.
    if (!this.lastPush) {
      await this._commit(Object.keys(next).map((k) => this._write(k, next[k])));
      this.lastPush = next;
      return true;
    }

    const writes = [];
    Object.keys(next).forEach((k) => {
      if (next[k] !== this.lastPush[k]) writes.push(this._write(k, next[k]));
    });
    Object.keys(this.lastPush).forEach((k) => {
      if (!(k in next)) {
        writes.push({ delete: this.DOCROOT + "/trackers/" + this.session.uid + "/" + k });
      }
    });

    if (!writes.length) return true;          // nothing actually changed
    await this._commit(writes);
    this.lastPush = next;
    return true;
  },

  /* ---------- reference data ----------
     The artist contact database: 972 booking and management addresses. It lives HERE,
     under the account's own document tree, rather than as a file next to the page,
     because this site is served from a PUBLIC GitHub repo — a static artists.js would
     publish every one of those addresses to the open internet and to git history.
     Behind the uid rule it is readable only by the signed-in owner.
     ~290 KB, comfortably inside the 1 MB per-document limit. */

  refUrl(name) { return FIRESTORE + "/trackers/" + this.session.uid + "/ref/" + name; },

  async loadRef(name) {
    const token = await this.token();
    const res = await fetch(this.refUrl(name), { headers: { Authorization: "Bearer " + token } });
    if (res.status === 404) return null;                 // not imported yet
    if (!res.ok) throw new Error(await describeError(res));
    const out = await res.json();
    const raw = out.fields && out.fields.json && out.fields.json.stringValue;
    if (!raw) return null;
    return { data: JSON.parse(raw), updatedAt: (out.fields.updatedAt || {}).timestampValue || null };
  },

  async saveRef(name, data) {
    const token = await this.token();
    const res = await fetch(this.refUrl(name), {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          json: { stringValue: JSON.stringify(data) },
          updatedAt: { timestampValue: new Date().toISOString() },
        },
      }),
    });
    if (!res.ok) throw new Error(await describeError(res));
    return true;
  },
};

function friendlyAuthError(out) {
  const code = ((out.error || {}).message || "").split(" ")[0];
  const map = {
    EMAIL_NOT_FOUND: "No account with that email.",
    INVALID_PASSWORD: "Wrong password.",
    INVALID_LOGIN_CREDENTIALS: "That email and password don't match.",
    INVALID_EMAIL: "That doesn't look like an email address.",
    USER_DISABLED: "That account has been disabled.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a minute and try again.",
    MISSING_PASSWORD: "Enter your password.",
  };
  return map[code] || "Could not sign in (" + (code || "unknown error") + ").";
}

async function describeError(res) {
  let detail = "";
  let status = "";
  try {
    const out = await res.json();
    detail = (out.error || {}).message || "";
    status = (out.error || {}).status || "";
  } catch (err) { /* non-JSON error body */ }

  if (res.status === 403 || status === "PERMISSION_DENIED") {
    return "PERMISSION_DENIED \u2014 Firestore refused the request. " +
      "This nearly always means the security rules haven't been published yet. " +
      "Firestore says: \u201c" + (detail || "no detail") + "\u201d";
  }
  if (res.status === 401) return "Your session expired. Please sign in again.";
  if (status === "NOT_FOUND" || res.status === 404) {
    return "NOT_FOUND \u2014 the Firestore database may not exist for this project.";
  }
  return "Firestore error " + res.status + (status ? " (" + status + ")" : "") +
    (detail ? ": " + detail : "");
}

// Surfaced on the error screen so a failure can be diagnosed without guesswork.
Cloud.diagnostics = function () {
  const s = Cloud.session || {};
  return {
    project: FB_CONFIG.projectId,
    signedInAs: s.email || "(not signed in)",
    accountId: s.uid || "(none)",
    documentPath: "trackers/" + (s.uid || "?") + "/{rec,ref}/...",
    rulesShouldMatch: "match /trackers/{userId} + match /{document=**} inside it",
  };
};
