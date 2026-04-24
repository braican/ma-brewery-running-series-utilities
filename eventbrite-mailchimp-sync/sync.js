#!/usr/bin/env node

import "dotenv/config";
import fs from "fs";
import https from "https";
import crypto from "crypto";
import { parse } from "csv-parse/sync";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;

const DC = MAILCHIMP_API_KEY?.split("-")[1];
const MC_BASE = `https://${DC}.api.mailchimp.com/3.0`;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!args.length || args.includes("--help")) {
  console.log(`
Usage: node eventbrite-mailchimp-sync.js <csv-file> <event-name> [--year YYYY] [--dry-run]

Arguments:
  <csv-file>      Path to the Eventbrite CSV export
  <event-name>    Name of the event (e.g. "Winch and Pulley")

Options:
  --year YYYY     Override the year (default: current year)
  --dry-run       Parse CSV and log what would happen without touching Mailchimp
  --verbose       Log full request payloads and error responses

Examples:
  node eventbrite-mailchimp-sync.js report.csv "Winch and Pulley"
  node eventbrite-mailchimp-sync.js report.csv "Winch and Pulley" --year 2025
  node eventbrite-mailchimp-sync.js report.csv "Winch and Pulley" --dry-run
`);
  process.exit(0);
}

const csvFile = args[0];
const eventName = args[1];

if (!csvFile || !eventName) {
  console.error("Error: both <csv-file> and <event-name> are required.");
  process.exit(1);
}

const yearIdx = args.indexOf("--year");
const year = yearIdx !== -1 ? args[yearIdx + 1] : new Date().getFullYear();
const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");

const runnerTag = `${year} ${eventName}`;
const volunteerTag = `${year} ${eventName} Volunteer`;

console.log(`Event:        ${eventName}`);
console.log(`Runner tag:   ${runnerTag}`);
console.log(`Volunteer tag:${volunteerTag}`);
if (dryRun) console.log(`Mode:         DRY RUN (no changes will be made)`);
console.log();

// ─── Validate env ─────────────────────────────────────────────────────────────

if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID) {
  console.error(
    "Error: MAILCHIMP_API_KEY and MAILCHIMP_AUDIENCE_ID must be set as environment variables.",
  );
  process.exit(1);
}

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

function md5(str) {
  return crypto.createHash("md5").update(str.toLowerCase()).digest("hex");
}

function parseCSV(filePath) {
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

async function upsertContact(registrant) {
  const { email, firstName, lastName, isVolunteer } = registrant;
  const tag = isVolunteer ? volunteerTag : runnerTag;
  const hash = md5(email);

  if (dryRun) return { isVolunteer, email, firstName, lastName, tag };

  const exists = audience.has(email);
  const payload = {
    email_address: email,
    status_if_new: "subscribed",
    ...(exists ? {} : { merge_fields: { FNAME: firstName, LNAME: lastName } }),
  };
  if (verbose)
    console.log(`  → sending payload for ${email}:`, JSON.stringify(payload));
  const upsert = await mcRequest(
    "PUT",
    `/lists/${MAILCHIMP_AUDIENCE_ID}/members/${hash}`,
    payload,
  );

  if (upsert.status >= 400) {
    console.error(
      `  ✗ Failed to upsert ${email}:`,
      verbose
        ? JSON.stringify(upsert.body)
        : upsert.body?.detail || upsert.body,
    );
    return false;
  }

  const tagRes = await mcRequest(
    "POST",
    `/lists/${MAILCHIMP_AUDIENCE_ID}/members/${hash}/tags`,
    { tags: [{ name: tag, status: "active" }] },
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
  if (!fs.existsSync(csvFile)) {
    console.error(`Error: file not found: ${csvFile}`);
    process.exit(1);
  }

  const registrants = parseCSV(csvFile);
  console.log(`Found ${registrants.length} registrants in CSV.\n`);

  const csvRegistrants = parseCSV(csvFile);
  console.log(`Found ${csvRegistrants.length} registrants in CSV.`);

  console.log("Fetching existing audience from Mailchimp...");
  const audience = await fetchAudience();
  console.log(`Found ${audience.size} existing contacts in audience.\n`);

  let ok = 0,
    fail = 0;

  if (dryRun) {
    const results = csvRegistrants.map((r) => ({
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
  } else {
    for (const r of csvRegistrants) {
      const success = await upsertContact(r);
      success ? ok++ : fail++;
    }
    console.log(`\nDone. ${ok} synced, ${fail} failed.`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
