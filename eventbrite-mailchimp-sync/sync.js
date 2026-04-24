#!/usr/bin/env node

import "dotenv/config";
import fs from "fs";
import https from "https";
import crypto from "crypto";
import { parse } from "csv-parse/sync";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
const EVENTBRITE_TOKEN = process.env.EVENTBRITE_PRIVATE_TOKEN;

const DC = MAILCHIMP_API_KEY?.split("-")[1];
const MC_BASE = `https://${DC}.api.mailchimp.com/3.0`;
const EB_BASE = `https://www.eventbriteapi.com/v3`;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!args.length || args.includes("--help")) {
  console.log(`
Usage: node sync.js <event-name> [--csv <path> | --event-id <id>] [--year YYYY] [--dry-run]

Arguments:
  <event-name>       Name of the event (e.g. "Winch and Pulley")

Import source (one required):
  --csv <path>       Path to an Eventbrite CSV export
  --event-id <id>    Eventbrite event ID to fetch attendees from the API

Options:
  --year YYYY        Override the year (default: current year)
  --dry-run          Preview what would be imported without touching Mailchimp

Examples:
  node sync.js "Winch and Pulley" --csv ~/Downloads/report.csv
  node sync.js "Winch and Pulley" --event-id 1980195354611
  node sync.js "Winch and Pulley" --event-id 1980195354611 --dry-run
`);
  process.exit(0);
}

const eventName = args[0]?.startsWith("--") ? null : args[0];

const csvIdx = args.indexOf("--csv");
const eventIdIdx = args.indexOf("--event-id");
const yearIdx = args.indexOf("--year");
const dryRun = args.includes("--dry-run");

const csvPath = csvIdx !== -1 ? args[csvIdx + 1] : null;
const eventId = eventIdIdx !== -1 ? args[eventIdIdx + 1] : null;
const year = yearIdx !== -1 ? args[yearIdx + 1] : new Date().getFullYear();

if (!eventName) {
  console.error("Error: <event-name> is required.");
  process.exit(1);
}

if (!csvPath && !eventId) {
  console.error("Error: one of --csv or --event-id is required.");
  process.exit(1);
}

if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID) {
  console.error(
    "Error: MAILCHIMP_API_KEY and MAILCHIMP_AUDIENCE_ID must be set.",
  );
  process.exit(1);
}

if (!csvPath && !EVENTBRITE_TOKEN) {
  console.error(
    "Error: EVENTBRITE_PRIVATE_TOKEN must be set when using --event-id.",
  );
  process.exit(1);
}

const runnerTag = `${year} ${eventName}`;
const volunteerTag = `${year} ${eventName} Volunteer`;

const importSource = csvPath ? "csv" : "eventbrite";

console.log(`Event:        ${eventName}`);
console.log(`Runner tag:   ${runnerTag}`);
console.log(`Volunteer tag:${volunteerTag}`);
console.log(
  `Import:       ${importSource === "csv" ? csvPath : `Eventbrite event ${eventId}`}`,
);
if (dryRun) console.log(`Mode:         DRY RUN (no changes will be made)`);
console.log();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mcRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${MC_BASE}${endpoint}`);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ebRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${EB_BASE}${endpoint}`);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: { Authorization: `Bearer ${EVENTBRITE_TOKEN}` },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function md5(str) {
  return crypto.createHash("md5").update(str.toLowerCase()).digest("hex");
}

// ─── Import sources ───────────────────────────────────────────────────────────

function importFromCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return records
    .map((row) => ({
      email: row["Email"]?.toLowerCase(),
      firstName: row["First Name"],
      lastName: row["Last Name"],
      isVolunteer: row["Ticket Type"] === "Volunteer",
    }))
    .filter((r) => r.email);
}

async function importFromEventbrite(id) {
  const registrants = [];
  let page = 1;

  while (true) {
    const res = await ebRequest(
      `/events/${id}/attendees/?page=${page}&status=attending`,
    );
    if (res.status >= 400) {
      console.error(
        "Error fetching Eventbrite attendees:",
        res.body?.error_description || res.body,
      );
      process.exit(1);
    }

    const { attendees, pagination } = res.body;
    for (const a of attendees) {
      const email = a.profile?.email?.toLowerCase();
      if (!email) continue;
      registrants.push({
        email,
        firstName: a.profile?.first_name,
        lastName: a.profile?.last_name,
        isVolunteer: a.ticket_class_name === "Volunteer",
      });
    }

    if (!pagination.has_more_items) break;
    page++;
  }

  return registrants;
}

// ─── Mailchimp ────────────────────────────────────────────────────────────────

async function fetchAudience() {
  const emails = new Set();
  let offset = 0;
  const count = 1000;

  while (true) {
    const res = await mcRequest(
      "GET",
      `/lists/${MAILCHIMP_AUDIENCE_ID}/members?count=${count}&offset=${offset}&fields=members.email_address`,
    );
    if (res.status >= 400) {
      console.error("Error fetching audience:", res.body?.detail || res.body);
      process.exit(1);
    }
    const members = res.body.members ?? [];
    for (const m of members) emails.add(m.email_address.toLowerCase());
    if (members.length < count) break;
    offset += count;
  }

  return emails;
}

async function upsertContact(registrant, audience) {
  const { email, firstName, lastName, isVolunteer } = registrant;
  const tag = isVolunteer ? volunteerTag : runnerTag;
  const hash = md5(email);
  const exists = audience.has(email);

  const payload = {
    email_address: email,
    status_if_new: "subscribed",
    ...(exists ? {} : { merge_fields: { FNAME: firstName, LNAME: lastName } }),
  };

  const upsert = await mcRequest(
    "PUT",
    `/lists/${MAILCHIMP_AUDIENCE_ID}/members/${hash}`,
    payload,
  );
  if (upsert.status >= 400) {
    console.error(
      `  ✗ Failed to upsert ${email}:`,
      upsert.body?.detail || upsert.body,
    );
    return false;
  }

  const tagRes = await mcRequest(
    "POST",
    `/lists/${MAILCHIMP_AUDIENCE_ID}/members/${hash}/tags`,
    {
      tags: [{ name: tag, status: "active" }],
    },
  );
  if (tagRes.status >= 400) {
    console.error(
      `  ✗ Failed to tag ${email}:`,
      tagRes.body?.detail || tagRes.body,
    );
    return false;
  }

  console.log(`  ✓ ${email} → ${tag}`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load registrants
  console.log(
    importSource === "csv"
      ? "Reading CSV..."
      : "Fetching attendees from Eventbrite...",
  );
  const registrants =
    importSource === "csv"
      ? importFromCSV(csvPath)
      : await importFromEventbrite(eventId);
  console.log(`Found ${registrants.length} registrants.\n`);

  // Load audience
  console.log("Fetching existing audience from Mailchimp...");
  const audience = await fetchAudience();
  console.log(`Found ${audience.size} existing contacts in audience.\n`);

  // Dry run
  if (dryRun) {
    const results = registrants.map((r) => ({
      ...r,
      tag: r.isVolunteer ? volunteerTag : runnerTag,
      exists: audience.has(r.email),
    }));

    const volunteers = results.filter((r) => r.isVolunteer);
    const runners = results.filter((r) => !r.isVolunteer);

    const printGroup = (label, group) => {
      console.log(`${label} (${group.length}):`);
      if (!group.length) {
        console.log("  (none)");
        return;
      }
      for (const r of group) {
        const action = r.exists ? "UPDATE" : "ADD   ";
        console.log(
          `  [${action}] ${r.email} (${r.firstName} ${r.lastName}) → ${r.tag}`,
        );
      }
    };

    printGroup("Runners", runners);
    console.log();
    printGroup("Volunteers", volunteers);

    const adds = results.filter((r) => !r.exists).length;
    const updates = results.filter((r) => r.exists).length;
    console.log(`\nDry run complete. ${adds} to add, ${updates} to update.`);
    return;
  }

  // Sync
  let ok = 0,
    fail = 0;
  for (const r of registrants) {
    const success = await upsertContact(r, audience);
    success ? ok++ : fail++;
  }
  console.log(`\nDone. ${ok} synced, ${fail} failed.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
