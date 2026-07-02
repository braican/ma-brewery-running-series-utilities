#!/usr/bin/env node

/**
 * create-campaigns.js
 *
 * For a given event, creates the three standard NEW BUILDER draft campaigns,
 * each with the correct audience plus subject/preview/title built from values
 * you enter at the prompt:
 *   1. "Invite a friend" -> everyone EXCEPT the event tag and the volunteer tag
 *   2. "Event details"   -> only the event tag
 *   3. "Recap"           -> the event tag OR the volunteer tag
 *
 * Note: Mailchimp's API can create multichannel (new-builder) campaigns and set
 * settings + audience, but it ignores settings.template_id for them and can't
 * write content. So per draft you still: pick the template, fill the tokens.
 *
 * Usage:
 *   node create-campaigns.js "Aeronaut"
 *   node create-campaigns.js "Aeronaut" --year 2026
 *   node create-campaigns.js "Aeronaut" --dry-run
 *   node create-campaigns.js --list-templates
 *
 * Env vars:
 *   MAILCHIMP_API_KEY
 *   MAILCHIMP_AUDIENCE_ID
 */

import "dotenv/config";
import https from "node:https";
import readline from "node:readline";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const FROM_NAME = "MA Brewery Running Series";
const REPLY_TO = "nick@breweryrunningseries.com";

// Per-event values that fill the subjects / preview text / titles.
// `default` may be a function of (eventName). Blank answers are allowed.
const FIELDS = [
  { key: "breweryNameShort", label: "Brewery short name", default: (ev) => ev },
  { key: "breweryName", label: "Brewery full name" },
  { key: "breweryCity", label: "Brewery city" },
  { key: "eventDateShort", label: "Event date, short (e.g. May 30)" },
  { key: "dayOfWeek", label: "Day of week (e.g. Saturday)" },
  { key: "nextEventBrewery", label: "Next event brewery (recap)" },
  { key: "nextEventCity", label: "Next event city (recap)" },
  { key: "nextEventDate", label: "Next event date (recap)" },
];

const TEMPLATES = {
  friend: {
    type: "friend",
    templateId: 10001585,
    templateName: "MA BRS 2026 Invite a Friend",
    subject: (v) =>
      `We're gearing up for our next run at ${v.breweryNameShort} in ${v.breweryCity}!`,
    preview: (v) =>
      `🍻 Run with us at ${v.breweryName} this weekend, ${v.eventDateShort}!`,
    title: (v, year) => `MA ${year} - ${v.breweryNameShort} - Invite a friend`,
    fill: [
      "BREWERY_NAME",
      "EVENT_DATE",
      "CITY_NAME",
      "BREWERY_ABOUT",
      "PROMO_COPY",
      "NONPROFIT_NAME",
      "NONPROFIT_MISSION",
      "+links: BREWERY, EVENTBRITE, NONPROFIT",
    ],
  },
  details: {
    type: "details",
    templateId: 10001586,
    templateName: "MA BRS 2026 Event Details",
    subject: (v) =>
      `Event Details: ${v.dayOfWeek} fun run at ${v.breweryName}!`,
    preview: (v) =>
      `🏃‍♀️‍➡️ Get ready! Here's everything you need to know for this weekend's event at ${v.breweryNameShort}!`,
    title: (v, year) => `MA ${year} - ${v.breweryNameShort} - Event Details`,
    fill: [
      "BREWERY_NAME",
      "CITY_NAME",
      "EVENT_DATE",
      "EVENT_TIME",
      "EVENT_TIME_CHECKIN",
      "EVENT_TIME_RAFFLE",
      "BREWERY_ADDRESS",
      "PARKING_INFO",
      "PUBLIC_TRANSIT_INFO",
      "QUESTION_OF_THE_DAY",
      "CTA_RUN_AGAIN",
      "NONPROFIT_NAME",
      "NONPROFIT_MISSION",
      "+links: BREWERY, BREWERY_ADDRESS, EVENTBRITE, MAPMYRUN, NONPROFIT",
    ],
  },
  recap: {
    type: "recap",
    templateId: 10001587,
    templateName: "MA BRS 2026 Event Recap",
    subject: (v) => `Thanks for running with us at ${v.breweryNameShort}! 🏃‍♀️`,
    preview: (v) =>
      `Next up – ${v.nextEventBrewery} in ${v.nextEventCity} on ${v.nextEventDate}!`,
    title: (v, year) => `MA ${year} - ${v.breweryNameShort} - Recap`,
    fill: [
      "BREWERY_NAME",
      "CITY_NAME",
      "EVENT_ALBUM",
      "PARTNER_LIST",
      "NONPROFIT_NAME",
      "NEXT_BREWERY_NAME",
      "NEXT_CITY_NAME",
      "NEXT_EVENT_DATE",
      "NEXT_EVENT_TIME",
      "NEXT_EVENT_PROMO",
      "+links: EVENT_ALBUM, NEXT_EVENT, NONPROFIT",
    ],
  },
};

// ─── Mailchimp request helper ────────────────────────────────────────────────

const API_KEY = process.env.MAILCHIMP_API_KEY;
const LIST_ID = process.env.MAILCHIMP_AUDIENCE_ID;

if (!API_KEY) {
  console.error("Missing MAILCHIMP_API_KEY");
  process.exit(1);
}
const DC = API_KEY.split("-")[1];
if (!DC) {
  console.error("Could not derive data center from API key");
  process.exit(1);
}

function mcRequest(method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: `${DC}.api.mailchimp.com`,
    path: `/3.0${path}`,
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise((resolve) =>
    rl.question(question, (a) => resolve(a.trim())),
  );
}

async function gatherValues(eventName) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const v = {};
  console.log(
    "\nEvent values for subjects / preview text / titles (blank = leave for later):",
  );
  for (const f of FIELDS) {
    const def =
      typeof f.default === "function" ? f.default(eventName, v) : f.default;
    const ans = await prompt(rl, `  ${f.label}${def ? ` [${def}]` : ""}: `);
    v[f.key] = ans || def || "";
  }
  rl.close();
  return v;
}

async function resolveTagId(name) {
  let offset = 0;
  const count = 1000;
  while (true) {
    const res = await mcRequest(
      "GET",
      `/lists/${LIST_ID}/segments?type=static&count=${count}&offset=${offset}`,
    );
    if (res.status >= 400) {
      console.error("Error fetching segments:", res.body?.detail || res.body);
      process.exit(1);
    }
    const segments = res.body.segments ?? [];
    const match = segments.find((s) => s.name === name);
    if (match) return match.id;
    if (segments.length < count) break;
    offset += count;
  }
  return null;
}

function segmentOpts(type, eventTagId, volunteerTagId) {
  const cond = (op, value) => ({
    condition_type: "StaticSegment",
    field: "static_segment",
    op,
    value,
  });
  switch (type) {
    case "friend":
      return {
        match: "all",
        conditions: [
          cond("static_not", eventTagId),
          cond("static_not", volunteerTagId),
        ],
      };
    case "details":
      return { match: "all", conditions: [cond("static_is", eventTagId)] };
    case "recap":
      return {
        match: "any",
        conditions: [
          cond("static_is", eventTagId),
          cond("static_is", volunteerTagId),
        ],
      };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list-templates")) {
    const res = await mcRequest(
      "GET",
      "/templates?type=user&count=100&fields=templates.id,templates.name,templates.type",
    );
    for (const t of res.body.templates ?? [])
      console.log(`${t.id}\t${t.type}\t${t.name}`);
    return;
  }

  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const eventName = positional[0];
  if (!eventName) {
    console.error(
      'Usage: node create-campaigns.js "Event Name" [--year YYYY] [--dry-run]',
    );
    process.exit(1);
  }
  if (!LIST_ID) {
    console.error("Missing MAILCHIMP_AUDIENCE_ID");
    process.exit(1);
  }

  const yearIdx = args.indexOf("--year");
  const year =
    yearIdx !== -1 ? args[yearIdx + 1] : String(new Date().getFullYear());

  const eventTag = `${year} ${eventName}`;
  const volunteerTag = `${year} ${eventName} Volunteer`;

  console.log(`Event:         ${eventName}`);
  console.log(`Event tag:     ${eventTag}`);
  console.log(`Volunteer tag: ${volunteerTag}`);

  const eventTagId = await resolveTagId(eventTag);
  const volunteerTagId = await resolveTagId(volunteerTag);
  if (!eventTagId) {
    console.error(`Tag not found: "${eventTag}"`);
    process.exit(1);
  }
  if (!volunteerTagId) {
    console.error(`Tag not found: "${volunteerTag}"`);
    process.exit(1);
  }
  console.log(`Resolved "${eventTag}" -> ${eventTagId}`);
  console.log(`Resolved "${volunteerTag}" -> ${volunteerTagId}`);

  const v = await gatherValues(eventName);

  const plan = [TEMPLATES.friend, TEMPLATES.details, TEMPLATES.recap];

  for (const c of plan) {
    const title = c.title(v, year);
    const subject = c.subject(v);
    const preview = c.preview(v);
    const opts = segmentOpts(c.type, eventTagId, volunteerTagId);

    console.log(`\n── ${title} ──`);
    console.log(`  Subject:  ${subject}`);
    console.log(`  Preview:  ${preview}`);
    console.log(
      `  Segment:  match=${opts.match}, ${opts.conditions.map((x) => `${x.op}(${x.value})`).join(", ")}`,
    );

    if (dryRun) {
      console.log("  (dry run — not created)");
      continue;
    }

    const created = await mcRequest("POST", "/campaigns", {
      type: "regular",
      content_type: "multichannel", // new builder
      recipients: { list_id: LIST_ID, segment_opts: opts },
      settings: {
        subject_line: subject,
        preview_text: preview,
        title,
        from_name: FROM_NAME,
        reply_to: REPLY_TO,
        template_id: c.templateId, // ignored by multichannel; kept per spec
      },
    });
    if (created.status >= 400) {
      console.error("  ✗ Create failed:", created.body?.detail || created.body);
      continue;
    }
    console.log(`  ✓ Draft created. In the builder:`);
    console.log(`      1) pick template "${c.templateName}"`);
    console.log(`      2) fill: ${c.fill.join(", ")}`);
    console.log(
      `    https://${DC}.admin.mailchimp.com/campaigns/edit?id=${created.body.web_id}`,
    );
  }

  console.log(
    "\nDone. Three new-builder drafts with audiences + subjects set — pick templates and fill in the builder.",
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
