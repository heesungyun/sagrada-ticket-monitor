import assert from "node:assert/strict";
import { evaluateResults } from "./monitor.mjs";

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

console.log("All local logic tests passed.");
