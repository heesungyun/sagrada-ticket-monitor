import assert from "node:assert/strict";
import {
  barcelonaToday,
  combineAlerts,
  evaluateResults,
  formatReported,
  markPersistent,
  parseReported,
  reportKey,
} from "./monitor.mjs";

const products = [
  { id: 4375, name: "basic" },
  { id: 4374, name: "guided" },
  { id: 4443, name: "tower" },
  { id: 4779, name: "guided+tower" },
];

const [basic, guided, tower, guidedTower] = products;

const DATE_A = "2030-03-01";
const DATE_B = "2030-03-02";

function finding(product, overrides = {}) {
  return {
    product,
    enforcesMinTickets: true,
    openAt4: [],
    openAt2: [],
    ...overrides,
  };
}

// 1. Enforcing product open at 4 -> "four".
{
  const findings = [finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] })];
  const alerts = evaluateResults(findings);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].date, DATE_A);
  assert.equal(alerts[0].kind, "four");
  assert.deepEqual(alerts[0].products.map((p) => p.id), [4443]);
}

// 2. Non-enforcing product open at 4 -> "unverified" (must NOT read as a confirmed 4).
{
  const findings = [
    finding(basic, { enforcesMinTickets: false, openAt4: [DATE_A] }),
  ];
  const alerts = evaluateResults(findings);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "unverified");
  assert.notEqual(alerts[0].kind, "four");
  assert.deepEqual(alerts[0].products.map((p) => p.id), [4375]);
}

// 3. Enforcing product NOT open at 4 but open at 2 -> "small-party".
{
  const findings = [finding(guided, { openAt4: [], openAt2: [DATE_A] })];
  const alerts = evaluateResults(findings);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "small-party");
  assert.deepEqual(alerts[0].products.map((p) => p.id), [4374]);
}

// 4. Nothing open -> no alert for that date.
{
  const findings = [
    finding(basic, { enforcesMinTickets: false }),
    finding(guided),
    finding(tower),
    finding(guidedTower),
  ];
  const alerts = evaluateResults(findings);
  assert.equal(
    alerts.some((a) => a.date === DATE_A),
    false,
  );
  assert.equal(alerts.length, 0);
}

// 5. Precedence: enforcing product confirmed at 4 + non-enforcing product open on
//    the same date -> exactly one alert, kind "four", listing only the enforcing product.
{
  const findings = [
    finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(basic, { enforcesMinTickets: false, openAt4: [DATE_A] }),
  ];
  const alerts = evaluateResults(findings);
  const dateAlerts = alerts.filter((a) => a.date === DATE_A);
  assert.equal(dateAlerts.length, 1);
  assert.equal(dateAlerts[0].kind, "four");
  assert.deepEqual(dateAlerts[0].products.map((p) => p.id), [4443]);
}

// 6. Precedence: non-enforcing "unverified" beats "small-party" on the same date.
{
  const findings = [
    finding(basic, { enforcesMinTickets: false, openAt4: [DATE_A] }),
    finding(guided, { openAt4: [], openAt2: [DATE_A] }),
  ];
  const alerts = evaluateResults(findings);
  const dateAlerts = alerts.filter((a) => a.date === DATE_A);
  assert.equal(dateAlerts.length, 1);
  assert.equal(dateAlerts[0].kind, "unverified");
  assert.deepEqual(dateAlerts[0].products.map((p) => p.id), [4375]);
}

// 7. Multiple dates in one run produce independent alerts.
{
  const findings = [
    finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(guided, { openAt4: [], openAt2: [DATE_B] }),
  ];
  const alerts = evaluateResults(findings);
  assert.equal(alerts.length, 2);

  const alertA = alerts.find((a) => a.date === DATE_A);
  assert.equal(alertA.kind, "four");
  assert.deepEqual(alertA.products.map((p) => p.id), [4443]);

  const alertB = alerts.find((a) => a.date === DATE_B);
  assert.equal(alertB.kind, "small-party");
  assert.deepEqual(alertB.products.map((p) => p.id), [4374]);
}

// 8. Fingerprints are stable and distinct across kinds/dates, and match the exact
//    documented format: `${kind}:${date}:${sortedProductIds.join(",")}`.
{
  const findings = [
    finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(guidedTower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(guided, { openAt4: [], openAt2: [DATE_B] }),
  ];
  const alerts = evaluateResults(findings);
  assert.equal(alerts.length, 2);

  const alertA = alerts.find((a) => a.date === DATE_A);
  assert.equal(alertA.kind, "four");
  // Product ids sorted ascending regardless of findings order.
  assert.deepEqual(alertA.products.map((p) => p.id).sort((x, y) => x - y), [4443, 4779]);
  assert.equal(alertA.fingerprint, `four:${DATE_A}:4443,4779`);

  const alertB = alerts.find((a) => a.date === DATE_B);
  assert.equal(alertB.kind, "small-party");
  assert.equal(alertB.fingerprint, `small-party:${DATE_B}:4374`);

  // Distinct across kinds and dates.
  const fingerprints = alerts.map((a) => a.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  assert.notEqual(alertA.fingerprint, alertB.fingerprint);

  // Re-running with the same inputs yields the same fingerprints (stability).
  const alertsAgain = evaluateResults(findings);
  assert.deepEqual(
    alertsAgain.map((a) => a.fingerprint).sort(),
    alerts.map((a) => a.fingerprint).sort(),
  );
}

// 9. An alert on `today` is cautioned; other dates are not. Passing no options
//    leaves every alert clean, as before the caution existed.
{
  const findings = [
    finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(guided, { openAt4: [], openAt2: [DATE_B] }),
  ];
  const alerts = evaluateResults(findings, { today: DATE_A });
  assert.deepEqual(alerts.find((a) => a.date === DATE_A).cautions, ["today"]);
  assert.deepEqual(alerts.find((a) => a.date === DATE_B).cautions, []);

  for (const unmarked of [evaluateResults(findings), evaluateResults(findings, {})]) {
    assert.deepEqual(unmarked.map((a) => a.cautions), [[], []]);
  }

  // A `today` that matches no alert adds nothing.
  assert.deepEqual(
    evaluateResults(findings, { today: "2030-03-03" }).map((a) => a.cautions),
    [[], []],
  );
}

// 10. The caution is not part of the fingerprint, so an alert that gains it
//     (the day rolling over to "today") is not re-sent as new.
{
  const findings = [finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] })];
  const [plain] = evaluateResults(findings);
  const [cautioned] = evaluateResults(findings, { today: DATE_A });
  assert.deepEqual(cautioned.cautions, ["today"]);
  assert.equal(cautioned.fingerprint, plain.fingerprint);
  assert.equal(cautioned.fingerprint, `four:${DATE_A}:4443`);
}

// 11. barcelonaToday follows Madrid wall-clock time, not UTC: correct either
//     side of local midnight, in summer (CEST, UTC+2) and winter (CET, UTC+1).
{
  assert.equal(barcelonaToday(new Date("2026-10-03T22:30:00Z")), "2026-10-04");
  assert.equal(barcelonaToday(new Date("2026-10-03T21:59:00Z")), "2026-10-03");
  assert.equal(barcelonaToday(new Date("2026-12-31T23:30:00Z")), "2027-01-01");
  assert.equal(barcelonaToday(new Date("2026-12-31T22:59:00Z")), "2026-12-31");
  // Clocks go back on 2026-10-25 (01:00Z): local midnight is 22:00Z before it
  // and 23:00Z after it.
  assert.equal(barcelonaToday(new Date("2026-10-24T22:30:00Z")), "2026-10-25");
  assert.equal(barcelonaToday(new Date("2026-10-25T22:30:00Z")), "2026-10-25");
  assert.equal(barcelonaToday(new Date("2026-10-25T23:00:00Z")), "2026-10-26");
  // Clocks go forward on 2026-03-29 (01:00Z): midnight is 23:00Z, then 22:00Z.
  assert.equal(barcelonaToday(new Date("2026-03-28T23:00:00Z")), "2026-03-29");
  assert.equal(barcelonaToday(new Date("2026-03-29T21:59:00Z")), "2026-03-29");
  assert.equal(barcelonaToday(new Date("2026-03-29T22:00:00Z")), "2026-03-30");
  assert.match(barcelonaToday(), /^\d{4}-\d{2}-\d{2}$/);
}

// 12. combineAlerts: a cautioned "four" ranks after a clean "small-party", so
//     the clean one leads the title; with only cautioned alerts the priority
//     drops to 3 and the title says the slot is likely closed.
{
  const findings = [
    finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(guided, { openAt4: [], openAt2: [DATE_B] }),
  ];
  const mixed = combineAlerts(evaluateResults(findings, { today: DATE_A }));
  assert.ok(mixed.title.startsWith(`Only 2-3 seats per slot - ${DATE_B}`));
  assert.ok(!mixed.title.startsWith("Likely closed slot"));
  assert.equal(mixed.priority, 4);
  assert.ok(mixed.message.indexOf(DATE_B) < mixed.message.indexOf(DATE_A));
  assert.ok(mixed.message.includes("CAUTION:"));

  const onlyCautioned = combineAlerts(
    evaluateResults([findings[0]], { today: DATE_A }),
  );
  assert.ok(onlyCautioned.title.startsWith("Likely closed slot: "));
  assert.equal(onlyCautioned.priority, 3);

  const clean = combineAlerts(evaluateResults([findings[0]]));
  assert.equal(clean.priority, 5);
}

// 13. markPersistent: an opening that stays open picks up the "persistent" caution
//    exactly when it has been open for the threshold, and not before.
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const openOn = (...dates) => evaluateResults([finding(tower, { openAt4: dates, openAt2: dates })]);
{
  const firstSeen = new Map();
  assert.deepEqual(markPersistent(openOn(DATE_A), firstSeen, T0, 15)[0].cautions, []);
  assert.deepEqual(markPersistent(openOn(DATE_A), firstSeen, T0 + 14 * MINUTE, 15)[0].cautions, []);
  assert.deepEqual(
    markPersistent(openOn(DATE_A), firstSeen, T0 + 15 * MINUTE, 15)[0].cautions,
    ["persistent"],
  );
  // Fresh alerts every sweep, so the caution is not carried over; it is recomputed.
  assert.deepEqual(
    markPersistent(openOn(DATE_A), firstSeen, T0 + 20 * MINUTE, 15)[0].cautions,
    ["persistent"],
  );
}

// 14. markPersistent: dates are tracked independently, and a date that disappears
//     for even one sweep loses its history, so a reopening starts a fresh clock.
{
  const firstSeen = new Map();
  markPersistent(openOn(DATE_A), firstSeen, T0, 15);
  const [a, b] = markPersistent(openOn(DATE_A, DATE_B), firstSeen, T0 + 10 * MINUTE, 15);
  assert.deepEqual(a.cautions, []);
  assert.deepEqual(b.cautions, []);
  // DATE_A is now 20 minutes old, DATE_B only 10.
  const [a2, b2] = markPersistent(openOn(DATE_A, DATE_B), firstSeen, T0 + 20 * MINUTE, 15);
  assert.deepEqual(a2.cautions, ["persistent"]);
  assert.deepEqual(b2.cautions, []);

  // Closed for one (empty) sweep, then back: the clock restarts.
  assert.deepEqual(markPersistent([], firstSeen, T0 + 21 * MINUTE, 15), []);
  assert.equal(firstSeen.size, 0);
  assert.deepEqual(markPersistent(openOn(DATE_A), firstSeen, T0 + 22 * MINUTE, 15)[0].cautions, []);
  assert.deepEqual(markPersistent(openOn(DATE_A), firstSeen, T0 + 36 * MINUTE, 15)[0].cautions, []);
  assert.deepEqual(
    markPersistent(openOn(DATE_A), firstSeen, T0 + 37 * MINUTE, 15)[0].cautions,
    ["persistent"],
  );
}

// 15. markPersistent: an opening that changes kind on the same date is still the
//     same opening, and marking never alters the fingerprint (no re-sent alerts).
{
  const firstSeen = new Map();
  const small = evaluateResults([finding(guided, { openAt2: [DATE_A] })]);
  assert.equal(small[0].kind, "small-party");
  markPersistent(small, firstSeen, T0, 15);

  const four = evaluateResults([finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] })]);
  assert.equal(four[0].kind, "four");
  const before = four[0].fingerprint;
  markPersistent(four, firstSeen, T0 + 15 * MINUTE, 15);
  assert.deepEqual(four[0].cautions, ["persistent"]);
  assert.equal(four[0].fingerprint, before);
  assert.equal(four[0].fingerprint, `four:${DATE_A}:4443`);

  // Marking the same alert twice must not stack the caution.
  markPersistent(four, firstSeen, T0 + 16 * MINUTE, 15);
  assert.deepEqual(four[0].cautions, ["persistent"]);
}

// 16. combineAlerts: when every alert is cautioned the mail is labelled and drops
//     to priority 3; a clean alert is ranked ahead of a cautioned one even when
//     the cautioned one is the better kind and the earlier date.
{
  const cautioned = (alert) => ({ ...alert, cautions: ["persistent"] });

  const all = combineAlerts([cautioned(openOn(DATE_A)[0])]);
  assert.equal(all.priority, 3);
  assert.ok(all.title.startsWith("Likely closed slot: "));

  const clean = evaluateResults([finding(guided, { openAt2: [DATE_B] })])[0];
  const stale = cautioned(openOn(DATE_A)[0]);
  assert.equal(stale.kind, "four");
  assert.equal(clean.kind, "small-party");

  const mixed = combineAlerts([stale, clean]);
  assert.ok(!mixed.title.startsWith("Likely closed slot: "));
  assert.ok(mixed.title.includes(DATE_B));
  assert.ok(mixed.title.endsWith("(+1 more)"));
  assert.equal(mixed.priority, 4);
  assert.ok(mixed.message.startsWith(`=== ${DATE_B} ===`));
}

// 17. Reported finds carried to the successor run: they round-trip, expire with
//     the cooldown, and the key is keyed by the secret so it does not expose the date.
{
  const HOUR = 3_600_000;
  const now = 1_800_000_000_000;
  const minute = (ms) => Math.floor(ms / 60000);
  const raw = `aaa@${minute(now - 1 * HOUR)},bbb@${minute(now - 7 * HOUR)},,junk`;
  const entries = parseReported(raw, now, 6);
  assert.deepEqual([...entries.keys()], ["aaa"]);
  assert.deepEqual(parseReported(formatReported(entries), now, 6), entries);
  assert.equal(parseReported("", now, 6).size, 0);
  assert.equal(parseReported(undefined, now, 6).size, 0);

  const alerts = evaluateResults([finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] })]);
  const key = reportKey("secret_topic_1", alerts);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(reportKey("secret_topic_1", alerts), key);
  assert.notEqual(reportKey("secret_topic_2", alerts), key);
  assert.ok(!key.includes(DATE_A));
  // Gaining a caution must not make an already-reported find look new.
  markPersistent(alerts, new Map([[DATE_A, 0]]), 60 * 60_000, 15);
  assert.equal(reportKey("secret_topic_1", alerts), key);

  // Same with several dates, where a caution reorders the combined alert.
  const two = evaluateResults([
    finding(tower, { openAt4: [DATE_A], openAt2: [DATE_A] }),
    finding(guided, { openAt4: [], openAt2: [DATE_B] }),
  ]);
  const before = combineAlerts(two).fingerprint;
  two.find((a) => a.date === DATE_A).cautions.push("persistent");
  assert.ok(combineAlerts(two).title.includes(DATE_B));
  assert.equal(combineAlerts(two).fingerprint, before);
}

console.log("All local logic tests passed.");
