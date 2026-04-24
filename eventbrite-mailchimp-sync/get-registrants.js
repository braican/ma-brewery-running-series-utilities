#!/usr/bin/env node

import "dotenv/config";
import https from "https";
import inquirer from "inquirer";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY;
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
const DC = MAILCHIMP_API_KEY?.split("-")[1];
const MC_BASE = `https://${DC}.api.mailchimp.com/3.0`;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!args.length || args.includes("--help")) {
  console.log(`
Usage: node get-registrants.js <event-name> [--year YYYY] [--volunteers] [--exclude-campaign]

Arguments:
  <event-name>            Name of the event (e.g. "Winch and Pulley")

Options:
  --year YYYY             Override the year (default: current year)
  --volunteers            Include volunteers in addition to runners
  --exclude-campaign      Interactively select campaigns whose recipients to exclude

Examples:
  node get-registrants.js "Winch and Pulley"
  node get-registrants.js "Winch and Pulley" --volunteers
  node get-registrants.js "Winch and Pulley" --exclude-campaign
  node get-registrants.js "Winch and Pulley" --volunteers --exclude-campaign
`);
  process.exit(0);
}

const eventName = args[0];

if (!eventName) {
  console.error("Error: <event-name> is required.");
  process.exit(1);
}

if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID) {
  console.error(
    "Error: MAILCHIMP_API_KEY and MAILCHIMP_AUDIENCE_ID must be set as environment variables.",
  );
  process.exit(1);
}

const yearIdx = args.indexOf("--year");
const year = yearIdx !== -1 ? args[yearIdx + 1] : new Date().getFullYear();

const includeVolunteers = args.includes("--volunteers");
const excludeCampaign = args.includes("--exclude-campaign");

const runnerTag = `${year} ${eventName}`;
const volunteerTag = `${year} ${eventName} Volunteer`;
const tagsToFetch = includeVolunteers ? [runnerTag, volunteerTag] : [runnerTag];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mcRequest(method, endpoint) {
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
    req.end();
  });
}

// ─── Fetch members with tag ───────────────────────────────────────────────────

async function fetchMembersWithTag(tagName) {
  const tagsRes = await mcRequest(
    "GET",
    `/lists/${MAILCHIMP_AUDIENCE_ID}/tag-search?name=${encodeURIComponent(tagName)}`,
  );

  if (tagsRes.status >= 400) {
    console.error("Error fetching tags:", tagsRes.body?.detail || tagsRes.body);
    process.exit(1);
  }

  const match = tagsRes.body.tags?.find((t) => t.name === tagName);
  if (!match) {
    console.error(`No tag found matching "${tagName}"`);
    process.exit(1);
  }

  const members = [];
  let offset = 0;
  const count = 1000;

  while (true) {
    const res = await mcRequest(
      "GET",
      `/lists/${MAILCHIMP_AUDIENCE_ID}/segments/${match.id}/members?count=${count}&offset=${offset}&fields=members.email_address`,
    );

    if (res.status >= 400) {
      console.error("Error fetching members:", res.body?.detail || res.body);
      process.exit(1);
    }

    const batch = res.body.members ?? [];
    members.push(...batch);
    if (batch.length < count) break;
    offset += count;
  }

  return members;
}

// ─── Campaign exclusion ───────────────────────────────────────────────────────

async function fetchRecentCampaigns() {
  const res = await mcRequest(
    "GET",
    `/campaigns?count=10&sort_field=send_time&sort_dir=DESC&list_id=${MAILCHIMP_AUDIENCE_ID}&status=sent&fields=campaigns.id,campaigns.settings.subject_line,campaigns.send_time`,
  );
  if (res.status >= 400) {
    console.error("Error fetching campaigns:", res.body?.detail || res.body);
    process.exit(1);
  }
  return res.body.campaigns ?? [];
}

async function fetchCampaignRecipients(campaignId) {
  const emails = new Set();
  let offset = 0;
  const count = 1000;

  while (true) {
    const res = await mcRequest(
      "GET",
      `/reports/${campaignId}/sent-to?count=${count}&offset=${offset}&fields=sent_to.email_address`,
    );
    if (res.status >= 400) {
      console.error(
        `Error fetching recipients for campaign ${campaignId}:`,
        res.body?.detail || res.body,
      );
      process.exit(1);
    }
    const batch = res.body.sent_to ?? [];
    for (const m of batch) emails.add(m.email_address.toLowerCase());
    if (batch.length < count) break;
    offset += count;
  }

  return emails;
}

async function buildExcludeSet() {
  const campaigns = await fetchRecentCampaigns();

  if (!campaigns.length) {
    console.log("No sent campaigns found.");
    return new Set();
  }

  const { selected } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selected",
      message: "Select campaigns to exclude recipients from:",
      choices: campaigns.map((c) => ({
        name: `${c.settings.subject_line}  (${new Date(
          c.send_time,
        ).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        })})`,
        value: c.id,
      })),
    },
  ]);

  if (!selected.length) {
    console.log("No campaigns selected, proceeding without exclusions.");
    return new Set();
  }

  const excludeSet = new Set();
  for (const campaignId of selected) {
    const campaign = campaigns.find((c) => c.id === campaignId);
    console.log(
      `Fetching recipients for "${campaign.settings.subject_line}"...`,
    );
    const recipients = await fetchCampaignRecipients(campaignId);
    for (const email of recipients) excludeSet.add(email);
  }

  console.log(
    `\nExcluding ${excludeSet.size} recipient(s) from selected campaign(s).`,
  );
  return excludeSet;
}

async function main() {
  const excludeSet = excludeCampaign ? await buildExcludeSet() : new Set();

  // Fetch members for each tag and merge, deduping by email
  const seen = new Set();
  const allMembers = [];

  for (const t of tagsToFetch) {
    console.log(`Fetching members with tag "${t}"...`);
    const members = await fetchMembersWithTag(t);
    for (const m of members) {
      if (!seen.has(m.email_address)) {
        seen.add(m.email_address);
        allMembers.push({ ...m, _tag: t });
      }
    }
  }

  // Filter and exclude
  const filtered = allMembers.filter(
    (m) => !excludeSet.has(m.email_address.toLowerCase()),
  );

  const printGroup = (label, members) => {
    if (!members.length) return;
    console.log(`\n${label} (${members.length}):\n`);
    for (const m of members) console.log(m.email_address);
  };

  if (includeVolunteers) {
    const runners = filtered.filter((m) => m._tag === runnerTag);
    const volunteers = filtered.filter((m) => m._tag === volunteerTag);
    printGroup("Runners", runners);
    printGroup("Volunteers", volunteers);
  } else {
    printGroup("Runners", filtered);
  }

  console.log(`\nTotal: ${filtered.length} contact(s).`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
