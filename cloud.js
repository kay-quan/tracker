/* ============================================================
   Cloud storage — Firebase Auth + Firestore, over plain REST.

   No SDK and no build step: the whole tracker stays dependency-free.
   Your records live in one Firestore document that only your signed-in
   account can read or write.
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
     The whole tracker is one JSON string in one document. That keeps every
     record together, avoids mapping nested data onto Firestore's typed value
     format, and stays far inside the 1 MB per-document limit. */

  docUrl() { return FIRESTORE + "/trackers/" + this.session.uid; },

  async load() {
    const token = await this.token();
    const res = await fetch(this.docUrl(), { headers: { Authorization: "Bearer " + token } });
    if (res.status === 404) return null;                 // first run: nothing saved yet
    if (!res.ok) throw new Error(await describeError(res));
    const out = await res.json();
    const raw = out.fields && out.fields.json && out.fields.json.stringValue;
    if (!raw) return null;
    return JSON.parse(raw);
  },

  async save(data) {
    const token = await this.token();
    const body = {
      fields: {
        json: { stringValue: JSON.stringify(data) },
        updatedAt: { timestampValue: new Date().toISOString() },
        device: { stringValue: navigator.platform || "web" },
      },
    };
    const res = await fetch(this.docUrl(), {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    documentPath: "trackers/" + (s.uid || "?"),
    rulesShouldMatch: "match /trackers/{userId}",
  };
};
