import { pathToFileURL } from "node:url";

// Which dates to watch, and any per-date constraints, come from configuration
// rather than source. This repository is public: travel dates and the reasons
// behind them are the owner's private business, not part of the program.
//   MONITOR_DATES   "YYYY-MM-DD,YYYY-MM-DD,..."
//   DATE_NOTES_JSON {"YYYY-MM-DD":"note shown in that date's alert"}
function configuredDates() {
  const raw = (process.env.MONITOR_DATES || "").trim();
  if (!raw) {
    throw new Error(
      "MONITOR_DATES is not set. Add it as a repository secret, " +
        "formatted as a comma-separated list of YYYY-MM-DD values.",
    );
  }
  const dates = raw.split(",").map((d) => d.trim()).filter(Boolean);
  const bad = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  if (bad.length) throw new Error(`MONITOR_DATES has malformed entries: ${bad.join(", ")}`);
  return dates;
}

function configuredNotes() {
  const raw = (process.env.DATE_NOTES_JSON || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    // A malformed note must not cost us a ticket alert.
    console.warn(`DATE_NOTES_JSON could not be parsed, continuing without notes: ${error.message}`);
    return {};
  }
}

const DATE_NOTES = configuredNotes();

const CONFIG = {
  // Lazy: importing this module (as the tests do) must not require the
  // deployment's configuration to be present.
  get dates() {
    if (!this._dates) this._dates = configuredDates();
    return this._dates;
  },
  salesGroupId: "1",
  pos: "649",
  // This key is embedded in the public Sagrada Familia ticket frontend flow.
  frontendSecretKey:
    process.env.CLORIAN_SECRET_KEY || "thesagradafamiliafrontendoftomorrow",
  // venueId is per product: it comes from the product's own productVenueSet.
  // Querying the wrong venue returns an empty object and silently monitors nothing.
  products: [
    {
      id: 4375,
      venueId: 1,
      name: "Sagrada Familia",
      url: "https://tickets.sagradafamilia.org/en/1-individual/4375-sagrada-familia",
    },
    {
      id: 4374,
      venueId: 1640,
      name: "Sagrada Familia with guided tour",
      url: "https://tickets.sagradafamilia.org/en/1-individual/4374-sagrada-familia-with-guided-tour",
    },
    {
      id: 4443,
      venueId: 3,
      name: "Sagrada Familia with towers",
      url: "https://tickets.sagradafamilia.org/en/1-individual/4443-sagrada-familia-with-towers",
    },
    {
      id: 4779,
      venueId: 1783,
      name: "Sagrada Familia with guided tour + towers",
      url: "https://tickets.sagradafamilia.org/en/1-individual/4779-sagrada-familia-with-guide-and-visit-to-the-towers",
    },
  ],
};

/**
 * Actions logs on a public repository are world-readable, and GitHub's secret
 * masking only catches a secret's exact literal. MONITOR_DATES is stored
 * comma-separated, so printing the same dates joined any other way - or one at
 * a time, or inside an alert title - slips straight past the mask and publishes
 * the trip.
 *
 * Rather than trusting every future call site to remember that, console output
 * is filtered centrally: a watched date is printed as its position (D1, D2...),
 * which stays useful for debugging and reveals nothing.
 */
function installLogRedaction() {
  const label = (date) => {
    let dates;
    try {
      dates = CONFIG.dates;
    } catch {
      return "D?";
    }
    const index = dates.indexOf(date);
    return index >= 0 ? `D${index + 1}` : "D?";
  };
  const redact = (value) =>
    typeof value === "string"
      ? value.replace(/\d{4}-\d{2}-\d{2}/g, label)
      : value;

  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(redact));
  }
}

installLogRedaction();

const AVAILABLE_STATE = "availability";
// If a product still reports availability at this party size, the backend is not
// applying the minTickets filter for that product at all, so any capacity claim
// derived from minTickets would be fiction. Verified against the live API.
const ABSURD_PARTY_SIZE = 100000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return response;
      const body = await response.text().catch(() => "");
      lastError = new Error(
        `${options.method || "GET"} ${url} -> ${response.status} ${body.slice(0, 300)}`,
      );
      // Do not hammer on client-side errors except rate limits.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    if (i < attempts - 1) await sleep(1000 * 2 ** i);
  }
  throw lastError || new Error(`Request failed: ${url}`);
}

async function fetchAccessToken() {
  const url = `https://services.clorian.com/user/api/oauth/token?secretKey=${encodeURIComponent(CONFIG.frontendSecretKey)}`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    body: "",
    headers: {
      accept: "application/json",
      "accept-language": "en-US",
      "content-type": "application/json",
      origin: "https://tickets.sagradafamilia.org",
      "user-agent": USER_AGENT,
    },
  });
  const payload = await response.json();
  if (!payload?.access_token) {
    throw new Error("Clorian token response did not contain access_token.");
  }
  return payload.access_token;
}

async function fetchAvailability(accessToken, product, minTickets) {
  // All target dates are October 2026, so a single monthly request covers Oct 3-8.
  const search = new URLSearchParams({
    minTickets: String(minTickets),
    month: "10",
    venueId: String(product.venueId),
    year: "2026",
  });
  const url = `https://services.clorian.com/catalog/salesGroups/${CONFIG.salesGroupId}/product/${product.id}/availability?${search}`;
  const response = await fetchWithRetry(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${accessToken}`,
      pos: CONFIG.pos,
      "content-type": "application/json",
      origin: "https://tickets.sagradafamilia.org",
      "user-agent": USER_AGENT,
    },
  });
  return await response.json();
}

function openDates(payload) {
  return CONFIG.dates.filter((date) => payload?.[date] === AVAILABLE_STATE);
}

/**
 * Turns per-product probe results into alerts.
 *
 * Each entry of `findings` is:
 *   { product, enforcesMinTickets, openAt4: string[], openAt2: string[] }
 *
 * `enforcesMinTickets` decides how much the API result is actually worth:
 *  - true  -> minTickets is a real "is there a single slot holding N people" filter,
 *             so openAt4 is a genuine 4-together confirmation.
 *  - false -> the backend ignores minTickets for this product, so all we know is
 *             that the day has some availability. Could be a single seat.
 */
export function evaluateResults(findings) {
  const alerts = [];

  // Dates come from the findings, not from global configuration: a date with
  // nothing open cannot produce an alert anyway, and deriving them here keeps
  // this function pure and testable without a configured deployment.
  const dates = [
    ...new Set(findings.flatMap((f) => [...f.openAt4, ...f.openAt2])),
  ].sort();

  for (const date of dates) {
    const confirmedFour = [];
    const unverified = [];
    const smallParty = [];

    for (const f of findings) {
      const openFour = f.openAt4.includes(date);
      if (!f.enforcesMinTickets) {
        if (openFour) unverified.push(f.product);
        continue;
      }
      if (openFour) confirmedFour.push(f.product);
      else if (f.openAt2.includes(date)) smallParty.push(f.product);
    }

    // Every ticket type's standing on this date, so one alert is enough to
    // decide from. When anything at all is open there is no time to go
    // looking the rest up.
    const statuses = findings.map((f) => {
      const openFour = f.openAt4.includes(date);
      let state;
      if (!f.enforcesMinTickets) state = openFour ? "OPEN - party size unverified" : "closed";
      else if (openFour) state = "OPEN - 4 seats in one slot";
      else if (f.openAt2.includes(date)) state = "OPEN - only 2-3 seats";
      else state = "closed";
      return { product: f.product, state };
    });

    const pick = (kind, products) => ({
      date,
      kind,
      products,
      statuses,
      fingerprint: `${kind}:${date}:${products.map((p) => p.id).sort().join(",")}`,
    });

    if (confirmedFour.length > 0) alerts.push(pick("four", confirmedFour));
    else if (unverified.length > 0) alerts.push(pick("unverified", unverified));
    else if (smallParty.length > 0) alerts.push(pick("small-party", smallParty));
  }

  return alerts;
}

function bookingUrl(product) {
  return product.url;
}

function titleFor(alert) {
  if (alert.kind === "four") return `4 TICKETS CONFIRMED - ${alert.date}`;
  if (alert.kind === "unverified") return `Opening (size unverified) - ${alert.date}`;
  return `Only 2-3 seats per slot - ${alert.date}`;
}

function messageFor(alert) {
  const names = (alert.statuses || alert.products.map((p) => ({ product: p, state: "OPEN" })))
    .map(({ product, state }) => `${state === "closed" ? "  ." : "  >"} ${product.name}: ${state}`)
    .join("\n");
  const explanation = {
    four:
      "A single time slot can take 4 people together. This is confirmed by the booking backend.",
    unverified:
      "This date opened up, but the backend does not report party size for this ticket type. It may be a single seat. Open the page and check before getting excited.",
    "small-party":
      "The best slot holds only 2-3 people, not 4. A 2+2 split across two slots may be possible - open the page and check a second slot now.",
  }[alert.kind];
  const note = DATE_NOTES[alert.date] ? `\n\n${DATE_NOTES[alert.date]}` : "";
  return `${explanation}\n\n${alert.date} \uc804\uccb4 \ud604\ud669:\n${names}${note}\n\nref:${alert.fingerprint}`;
}

function priorityFor(alert) {
  if (alert.kind === "four") return 5;
  return 4;
}

function normalizeTopic(topic) {
  if (!topic) return null;
  const value = topic.trim();
  if (!/^[-_A-Za-z0-9]{8,64}$/.test(value)) {
    throw new Error(
      "NTFY_TOPIC must be 8-64 characters using only letters, numbers, hyphen, or underscore.",
    );
  }
  return value;
}

async function wasRecentlySent(topic, fingerprint, hoursOverride) {
  const hours = Number(hoursOverride ?? process.env.ALERT_COOLDOWN_HOURS ?? 2);
  if (!Number.isFinite(hours) || hours <= 0) return false;

  const url = `https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(`${hours}h`)}`;
  try {
    const response = await fetchWithRetry(url, { headers: { accept: "application/x-ndjson" } }, 1);
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (String(event?.message || "").includes(`ref:${fingerprint}`)) return true;
      } catch {
        // Ignore malformed history lines.
      }
    }
  } catch (error) {
    console.warn(`ntfy history check failed; sending alert anyway: ${error.message}`);
  }
  return false;
}

async function postNtfy(topic, body) {
  const token = (process.env.NTFY_TOKEN || "").trim();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchWithRetry("https://ntfy.sh/", {
    method: "POST",
    headers,
    body: JSON.stringify({ topic, ...body }),
  });
  await response.text();
}

/**
 * Email is the PRIMARY channel here, not a backup: iOS push never reaches this
 * device (verified against a second, unrelated topic, so it is not a per-topic
 * registration fault). Every alert therefore carries email, including the
 * failure alerts - if the monitor dies and push is dead too, silence would be
 * indistinguishable from "no tickets".
 *
 * Requires both an address and a token: ntfy.sh answers anonymous email sends
 * with 40053, and an unverified address with 40052.
 */
function alertEmail() {
  const address = (process.env.ALERT_EMAIL || "").trim();
  const token = (process.env.NTFY_TOKEN || "").trim();
  if (!address || !token) return null;
  return address;
}

/**
 * ntfy's free tier allows only 5 emails, and email is the one channel that
 * actually reaches this phone. Sending one mail per open date would spend that
 * budget fastest exactly when it matters most - several dates opening at once
 * is the best news possible, and the old code turned it into dropped alerts.
 * So a run sends at most one mail, covering every date it found.
 */
function combineAlerts(alerts) {
  const rank = { four: 0, unverified: 1, "small-party": 2 };
  const sorted = [...alerts].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.date.localeCompare(b.date),
  );
  const best = sorted[0];
  const dates = sorted.map((a) => a.date);

  const title =
    dates.length === 1
      ? titleFor(best)
      : `${titleFor(best)} (+${dates.length - 1} more)`;

  const body = sorted
    .map((a) => `=== ${a.date} ===\n${messageFor(a)}`)
    .join("\n\n");

  return {
    title,
    message: body,
    priority: priorityFor(best),
    click: bookingUrl(best.products[0]),
    fingerprint: `combined:${sorted.map((a) => a.fingerprint).join("|")}`,
  };
}

async function sendCombinedAlert(topic, alerts) {
  const combined = combineAlerts(alerts);
  if (await wasRecentlySent(topic, combined.fingerprint)) {
    console.log(`Skipping duplicate notification for ${combined.fingerprint}`);
    return;
  }
  const email = alertEmail();
  const payload = {
    title: combined.title,
    message: `${combined.message}\n\nref:${combined.fingerprint}`,
    priority: combined.priority,
    tags: ["ticket"],
    click: combined.click,
  };
  try {
    await postNtfy(topic, email ? { ...payload, email } : payload);
  } catch (error) {
    if (!email) throw error;
    console.warn(`Email channel failed (${error.message}); resending push only.`);
    await postNtfy(topic, payload);
  }
  console.log(`Notification sent: ${combined.title}${email ? " (+ email)" : ""}`);
}

async function sendNtfy(topic, alert) {
  if (await wasRecentlySent(topic, alert.fingerprint)) {
    console.log(`Skipping duplicate notification for ${alert.fingerprint}`);
    return;
  }
  const email = alertEmail();
  const payload = {
    title: titleFor(alert),
    message: messageFor(alert),
    priority: priorityFor(alert),
    tags: ["ticket"],
    click: bookingUrl(alert.products[0]),
  };
  try {
    await postNtfy(topic, email ? { ...payload, email } : payload);
  } catch (error) {
    if (!email) throw error;
    // Losing the push because the email side is misconfigured would be the
    // worst possible trade. Drop the email and get the alert out.
    console.warn(`Email channel failed (${error.message}); resending push only.`);
    await postNtfy(topic, payload);
  }
  console.log(`Notification sent: ${titleFor(alert)}${email ? " (+ email)" : ""}`);
}

async function sendFailureAlert(topic, error) {
  // Throttled separately and harder: a broken monitor should tell you once every
  // 6 hours, not every 15 minutes.
  const fingerprint = "monitor-failure";
  if (await wasRecentlySent(topic, fingerprint, 6)) {
    console.log("Failure alert suppressed (already sent within 6h).");
    return;
  }
  const email = alertEmail();
  await postNtfy(topic, {
    title: "Sagrada monitor is BROKEN",
    message:
      `The checker failed, so silence no longer means "no tickets". Check the GitHub Actions log.\n\n` +
      `${String(error?.message || error).slice(0, 300)}\n\nref:${fingerprint}`,
    priority: 4,
    tags: ["warning"],
    ...(email ? { email } : {}),
  });
  console.log("Failure alert sent.");
}

async function sendDegradedAlert(topic, problems) {
  // Some ticket types were checked and some were not. Silence about the broken
  // ones must not be mistaken for "no tickets".
  const fingerprint = `degraded:${problems.length}`;
  if (await wasRecentlySent(topic, fingerprint, 6)) {
    console.log("Degraded-mode alert suppressed (already sent within 6h).");
    return;
  }
  const email = alertEmail();
  await postNtfy(topic, {
    title: "Sagrada monitor partially blind",
    message:
      `${problems.length} ticket type(s) could not be checked. The others are still being monitored.\n\n` +
      `${problems.join("\n")}\n\nref:${fingerprint}`,
    priority: 4,
    tags: ["warning"],
    ...(email ? { email } : {}),
  });
  console.log("Degraded-mode alert sent.");
}

// Hour (UTC) for the daily "still alive" mail. 08:00 UTC is 17:00 in Korea.
const HEARTBEAT_HOUR_UTC = Number(process.env.HEARTBEAT_HOUR_UTC ?? 8);

/**
 * The one failure this monitor cannot otherwise report: if the Actions quota
 * runs out the workflow stops executing, so it cannot mail about being broken.
 * Silence then means either "no tickets" or "dead", which is exactly the
 * ambiguity the failure alert exists to remove. A daily heartbeat restores it -
 * if the mail stops arriving, something is wrong.
 *
 * Deduped over 6h rather than 24h because ntfy.sh only retains messages for
 * about 12 hours, so a longer lookback would find nothing and fire every run.
 * Pinning it to one hour of the day is what actually makes it daily.
 */
async function sendHeartbeat(topic, findings) {
  if (new Date().getUTCHours() !== HEARTBEAT_HOUR_UTC) return;
  const fingerprint = "heartbeat";
  if (await wasRecentlySent(topic, fingerprint, 6)) return;

  const checked = findings.map((f) => `  . ${f.product.name}`).join("\n");
  const email = alertEmail();
  await postNtfy(topic, {
    title: "Sagrada monitor alive - no tickets yet",
    message:
      `Checked ${CONFIG.dates[0]} to ${CONFIG.dates[CONFIG.dates.length - 1]}, nothing open.\n\n` +
      `Watching:\n${checked}\n\n` +
      `If this daily mail stops arriving, the monitor has stopped running.\n\nref:${fingerprint}`,
    priority: 1,
    tags: ["heartbeat"],
    ...(email ? { email } : {}),
  });
  console.log("Heartbeat sent.");
}

async function sendManualTest(topic) {
  await postNtfy(topic, {
    title: "Sagrada monitor test OK",
    message: "Cloud monitoring is connected. Scheduled checks will now run automatically.",
    priority: 3,
    tags: ["white_check_mark"],
    click: bookingUrl(CONFIG.products[0]),
  });
  console.log("Manual test notification sent.");
}

/**
 * Once the trip is over the schedule would otherwise keep firing forever, and
 * every run still bills a full minute even though it does nothing. So the
 * monitor switches itself off rather than quietly burning the account's quota
 * for months. Needs `actions: write` on the workflow token.
 */
async function disableSelf() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("Not running in GitHub Actions; leaving the schedule alone.");
    return;
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/disable`,
      {
        method: "PUT",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (response.ok || response.status === 204) {
      console.log("Schedule disabled. This workflow will not run again.");
    } else {
      console.warn(`Could not disable the schedule: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.warn(`Could not disable the schedule: ${error?.message || error}`);
  }
}

function afterMonitoringWindow() {
  // Derived from the configured dates rather than hardcoded, so the source
  // carries no trace of when the trip actually is. Stops at noon UTC the day
  // after the last watched date.
  const dates = CONFIG.dates;
  const last = dates[dates.length - 1];
  const stopAt = Date.parse(`${last}T12:00:00Z`) + 24 * 60 * 60 * 1000;
  return Date.now() > stopAt;
}

function availabilityCount(payload) {
  return Object.values(payload || {}).filter((v) => v === AVAILABLE_STATE).length;
}

/**
 * Probes one product. Returns a finding, or throws with a description of what broke.
 *
 * Note the two response shapes this has to tolerate, both seen live:
 *  - 4375 / 4374 / 4443 always return all 31 day keys and flip the *values*.
 *  - 4779 returns only the days that pass the filter, so a strict filter yields {}.
 * That is why the venue sanity check uses the permissive minTickets=1 query, and
 * why enforcement is decided by counting "availability" values rather than keys.
 */
async function probeProduct(accessToken, product) {
  const base = await fetchAvailability(accessToken, product, 1);
  await sleep(150);
  if (Object.keys(base).length === 0) {
    throw new Error(
      `${product.name} (${product.id}) returned an empty calendar at minTickets=1 for ` +
        `venueId=${product.venueId}. Either the venue mapping changed or the whole month is gone. ` +
        `This ticket type is NOT being monitored.`,
    );
  }

  const absurd = await fetchAvailability(accessToken, product, ABSURD_PARTY_SIZE);
  await sleep(150);
  // If a party of 100000 still "fits", the backend is not applying minTickets to
  // this product, so nothing it says about party size can be trusted.
  const enforcesMinTickets = availabilityCount(absurd) === 0;

  const openAt4 = openDates(await fetchAvailability(accessToken, product, 4));
  await sleep(150);

  let openAt2 = [];
  if (enforcesMinTickets && openAt4.length < CONFIG.dates.length) {
    openAt2 = openDates(await fetchAvailability(accessToken, product, 2));
    await sleep(150);
  }

  return { product, enforcesMinTickets, openAt4, openAt2 };
}

const POLL_MINUTES = Number(process.env.POLL_MINUTES ?? 50);
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS ?? 90);

/**
 * One sweep of all four ticket types. Returns what it found so the caller can
 * decide about notifications; it deliberately does not send anything itself,
 * because a polling run sweeps many times and must not mail on every pass.
 */
async function sweep(accessToken) {
  const findings = [];
  const problems = [];
  // One broken ticket type must not blind us to the other three.
  for (const product of CONFIG.products) {
    try {
      findings.push(await probeProduct(accessToken, product));
    } catch (error) {
      problems.push(error?.message || String(error));
      console.error(`[${product.id}] FAILED: ${error?.message || error}`);
    }
  }
  return { findings, problems };
}

/**
 * Asks GitHub to start the next run as this one ends.
 *
 * GitHub's scheduler was measured delivering about 8 runs a day against a cron
 * asking for 84, with roughly 3-hour gaps - so cron alone cannot give dense
 * coverage no matter what it requests. Chaining removes the scheduler from the
 * path: each run starts the next, and the cron entry becomes a recovery
 * mechanism for when a chain breaks rather than the thing driving cadence.
 *
 * Safe against runaway chains: the chain stops at the monitoring window, only
 * one run exists at a time, and the workflow's concurrency group would collapse
 * accidental overlap.
 */
async function chainNextRun() {
  if (process.env.CHAIN_RUNS === "false") return;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF_NAME || "main";
  if (!token || !repo) {
    console.log("Not running in GitHub Actions; not chaining.");
    return;
  }
  if (afterMonitoringWindow()) {
    console.log("Monitoring window has ended; not chaining.");
    return;
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref, inputs: { chained: "true" } }),
      },
    );
    if (response.status === 204) console.log("Next run dispatched.");
    else console.warn(`Could not chain next run: ${response.status} ${await response.text()}`);
  } catch (error) {
    console.warn(`Could not chain next run: ${error?.message || error}`);
  }
}

export async function main() {
  const topic = normalizeTopic(process.env.NTFY_TOPIC);
  const manualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const chained = process.env.CHAINED_RUN === "true";

  if (!topic) {
    throw new Error(
      "Missing NTFY_TOPIC. Add it as a GitHub Actions repository secret before running the monitor.",
    );
  }

  // A chained run is not a human pressing the button, so it must not mail a
  // test notification every cycle and burn the daily email budget.
  if (manualRun && !chained && process.env.SEND_TEST_ON_MANUAL !== "false") {
    await sendManualTest(topic);
  }

  if (afterMonitoringWindow()) {
    console.log("Monitoring window has ended. No API calls made.");
    await disableSelf();
    return;
  }

  const deadline = Date.now() + POLL_MINUTES * 60 * 1000;
  let accessToken = await fetchAccessToken();
  let found = false;
  let sweeps = 0;

  // Keep watching for the whole run rather than sampling once and exiting.
  // Wall-clock coverage is what decides whether a short opening is seen at all.
  while (Date.now() < deadline) {
    sweeps += 1;
    let result;
    try {
      result = await sweep(accessToken);
    } catch (error) {
      // Most likely an expired Clorian token; get a fresh one and carry on.
      console.warn(`Sweep failed, refreshing token: ${error?.message || error}`);
      accessToken = await fetchAccessToken();
      continue;
    }

    const { findings, problems } = result;
    const alerts = evaluateResults(findings);

    if (alerts.length > 0) {
      found = true;
      const summary = alerts.map((a) => `${a.date} (${a.kind})`).join(", ");
      console.log(`::error title=Sagrada tickets available::${summary} - open the booking page now`);
      try {
        await sendCombinedAlert(topic, alerts);
      } catch (error) {
        problems.push(`alert: ${error?.message || error}`);
        console.error(`Failed to send alert: ${error?.message || error}`);
      }
    } else if (sweeps === 1) {
      console.log(`Nothing open across ${CONFIG.dates.length} watched dates.`);
      try {
        await sendHeartbeat(topic, findings);
      } catch (error) {
        // Swallowing this is what let a dead ntfy token go unnoticed for days
        // while every run still reported success.
        problems.push(`heartbeat: ${error?.message || error}`);
        console.error(`Heartbeat failed: ${error?.message || error}`);
      }
    }

    if (problems.length > 0) {
      try {
        await sendDegradedAlert(topic, problems);
      } catch (error) {
        console.error(`Degraded alert could not be sent: ${error?.message || error}`);
      }
      process.exitCode = 1;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_SECONDS * 1000, remaining));
  }

  console.log(`Completed ${sweeps} sweeps over ${POLL_MINUTES} minutes.`);
  await chainNextRun();

  // Deliberately fail the run when tickets are found: GitHub mails the account
  // owner on failure, which needs no ntfy token and no working phone push.
  if (found) process.exitCode = 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error?.stack || error?.message || String(error));
    try {
      const topic = normalizeTopic(process.env.NTFY_TOPIC);
      if (topic) await sendFailureAlert(topic, error);
    } catch (alertError) {
      console.error(`Could not send failure alert: ${alertError?.message}`);
    }
    process.exitCode = 1;
  });
}
