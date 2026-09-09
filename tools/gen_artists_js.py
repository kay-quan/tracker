#!/usr/bin/env python3
"""Build artists.payload.json from the Life Tracker kit's artists.json.

The output is imported once from Settings and stored per-account in Firestore. It is
deliberately NOT a file served next to the page: this repo is public and serves GitHub
Pages, so a static artists.js would publish 972 third-party booking and management
addresses to the open internet and into git history permanently. The payload trims the
1.26 MB source to ~289 KB, which fits inside one 1 MB Firestore document.

Ranking logic is lifted from the kit's gen_artist_lookup.py on purpose. The order is
load-bearing and documented in docs/ARTIST-DB.md: a stale-flagged address always loses
to an unflagged one, and a manager always outranks the artist's own inbox.

The generated file is gitignored. Keep it that way.

Run:  python3 tools/gen_artists_js.py          (dry run)
      python3 tools/gen_artists_js.py --apply
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
KIT = ROOT.parent / "life-tracker-kit"
SRC = KIT / "data" / "artists.json"
APPLY = "--apply" in sys.argv

db = json.load(open(SRC, encoding="utf-8"))

RANK = {'management': 0, 'media': 1, 'tour_manager': 2, 'label_press': 3,
        'booking': 4, 'general': 5, 'label': 6}
CONF = {'high': 0, 'medium': 1, 'low': 2}


def dual(c):
    d = c.get('verifiedBy') or {}
    ok = lambda s: s in ('correct', 'corroborated')
    return ok((d.get('claude') or {}).get('status')) and ok((d.get('codex') or {}).get('status'))


def risky(c):
    # Three tiers, not two. A FLAGGED stale address is worse than a merely
    # weakly-evidenced one; collapsing them lets a flagged address win on rank.
    if c.get('staleRisk'):
        return 2
    return 1 if c.get('confidence') == 'low' else 0


ROLE_LOCAL = ('mgmt', 'management', 'manager', 'booking', 'book', 'info', 'contact', 'press',
              'media', 'demos', 'demo', 'submission', 'team', 'office', 'support', 'admin',
              'agency', 'talent', 'sales', 'hello', 'inquiries', 'enquiries')
FREE_HOST = ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com',
             'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'aol.com', 'live.com',
             'msn.com')


def _norm(x):
    return re.sub(r'[^a-z0-9]', '', (x or '').lower())


def artist_direct(name, c):
    """Is this the act's OWN inbox rather than a third party's desk?

    A role mailbox is never the artist even on the artist's own domain, and the act's
    name on an agency domain is an alias for them, not them."""
    em = (c.get('email') or '').lower()
    if '@' not in em:
        return False
    nm = _norm(name)
    if len(nm) < 3:
        return False
    if c.get('person'):
        return False
    org = _norm(c.get('org'))
    if org and org != nm:
        return False
    local, dom = em.split('@', 1)[0], em.split('@', 1)[1]
    if any(r in _norm(local) for r in ROLE_LOCAL):
        return False
    if dom not in FREE_HOST and nm not in _norm(dom.split('.')[0]):
        return False
    return nm in _norm(local)


def order(name, cs):
    return sorted(cs, key=lambda c: (risky(c),
                                     1 if artist_direct(name, c) else 0,
                                     0 if dual(c) else 1,
                                     RANK.get(c.get('type'), 9),
                                     CONF.get(c.get('confidence'), 3),
                                     0 if c.get('person') else 1))


key = lambda n: re.sub(r'[^a-z0-9]', '', (n or '').lower())

acts, lookup, fests, alias = {}, {}, {}, 0

for v in db.values():
    name = v.get('name')
    if not name:
        continue
    k = key(name)
    # Keep name-only entries. A manager's name with no address on file is still a lead
    # (docs/ARTIST-DB.md), and it is exactly what the email hunt starts from later.
    # Only addressed contacts are draftable, so those are ordered first.
    allc = v.get('contacts') or []
    cs = order(name, [c for c in allc if c.get('email')])
    leads = [c for c in allc if not c.get('email')]
    soc = v.get('socials') or {}
    rec = {
        "n": name,
        "c": [{"e": c["email"], "t": c.get('type', ''), "p": c.get('person') or '',
               "o": c.get('org') or '', "q": c.get('confidence') or '',
               "s": c.get('source') or '', "d": 1 if dual(c) else 0,
               "r": 1 if c.get('staleRisk') else 0} for c in cs],
        "st": v.get('status') or '',
        "f": v.get('festivals') or [],
    }
    if v.get('agency'):
        rec["ag"] = v["agency"]
    if soc.get('followers') is not None:
        rec["fo"] = soc["followers"]
    if soc.get('instagram'):
        rec["ig"] = soc["instagram"]
    if leads:
        rec["ld"] = [{"p": c.get('person') or '', "o": c.get('org') or '',
                      "t": c.get('type', ''), "s": c.get('source') or ''} for c in leads]
    acts[k] = rec

    for f in rec["f"]:
        fests.setdefault(f, []).append(k)

    if cs:
        b = cs[0]
        lookup[k] = {"e": b["email"], "t": b.get('type', ''),
                     "o": b.get('org') or '', "p": b.get('person') or ''}

# Alternate billings must resolve too. A show feed prints "DJ Kendo" for Kendo; without
# the alias key that chip silently shows no address though one is on file.
for v in db.values():
    name = v.get('name')
    if not name:
        continue
    k = key(name)
    if k not in lookup:
        continue
    for other in (v.get('billedAs') or []):
        ak = key(other)
        if ak and ak not in lookup:
            lookup[ak] = dict(lookup[k])
            acts.setdefault(ak, {"n": other, "c": acts[k]["c"], "st": acts[k]["st"],
                                 "f": acts[k]["f"], "alias": k})
            alias += 1

for f in fests:
    fests[f].sort(key=lambda k: acts[k]["n"].lower())

real = [a for a in acts.values() if "alias" not in a]
addresses = sum(len(a.get("c") or []) for a in real)
leadonly = sum(len(a.get("ld") or []) for a in real)
# Count distinct real acts, NOT len(lookup) -- that includes alternate-billing keys and
# reports ~20 more acts than exist.
reachable = sum(1 for a in real if a.get("c"))

print("acts          %d" % len(real))
print("reachable     %d  (have >=1 address)" % reachable)
print("addresses     %d" % addresses)
print("name-only     %d  (manager known, no address yet)" % leadonly)
print("festivals     %d" % len(fests))
print("lookup keys   %d  (incl. +%d alternate billings)" % (len(lookup), alias))
for f in sorted(fests, key=lambda x: -len(fests[x])):
    print("   %4d  %s" % (len(fests[f]), f))

j = lambda o: json.dumps(o, separators=(",", ":"), ensure_ascii=False)

PAYLOAD = ROOT / "artists.payload.json"
payload = j({"acts": acts, "lookup": lookup, "festivals": fests,
             "stats": {"acts": len(real), "reachable": reachable, "addresses": addresses,
                       "leads": leadonly, "festivals": len(fests)}})

if APPLY:
    PAYLOAD.write_text(payload, encoding="utf-8")
    print("\nWROTE %s  (%.1f KB)  -- import this in Settings" % (PAYLOAD, len(payload) / 1024))
    if len(payload) > 1000000:
        print("\n!! %.0f KB exceeds the 1 MB Firestore document limit -- it must be split."
              % (len(payload) / 1024))
else:
    print("\nDRY RUN -- would write %s (%.1f KB). Re-run with --apply."
          % (PAYLOAD, len(payload) / 1024))
