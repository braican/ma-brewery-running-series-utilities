#!/usr/bin/env node

/**
 * create-campaigns.js
 *
 * For a given event, creates the three standard draft campaigns in Mailchimp:
 *   1. "Send to a friend"  -> everyone EXCEPT the event tag and the volunteer tag
 *   2. "Event details"     -> only the event tag
 *   3. "Event recap"       -> the event tag OR the volunteer tag
 *
 * Each campaign is created from a saved Mailchimp template, then its rendered
 * HTML is pulled down, placeholders are filled, and it's pushed back up. Two
 * kinds of placeholder are supported:
 *   - Twig text tokens:   {{ TOKEN_NAME }}   (spaces optional)
 *   - Link placeholders:  https://NAME.LINK  (replaced with a full URL)
 * Everything is left as a DRAFT for you to review and send.
 *
 * Usage:
 *   node create-campaigns.js "Aeronaut"
 *   node create-campaigns.js "Aeronaut" --year 2026
 *   node create-campaigns.js "Aeronaut" --dry-run
 *   node create-campaigns.js --list-templates
 *
 * Env vars (same as your other scripts):
 *   MAILCHIMP_API_KEY
 *   MAILCHIMP_AUDIENCE_ID
 */

const https = require("https");
const readline = require("readline");

// ─── CONFIG — fill these in once ────────────────────────────────────────────

// Numeric template IDs (run --list-templates to find them).
// `tokens` = {{ }} text placeholders; `links` = https://NAME.LINK placeholders.
const TEMPLATES = {
  friend: {
    templateId: 0,
    titleSuffix: "Send to a Friend",
    subjectLine: "Run with us at {{ BREWERY_NAME }}!",
    tokens: [
      "BREWERY_NAME", "EVENT_DATE", "CITY_NAME", "BREWERY_ABOUT",
      "PROMO_COPY", "NONPROFIT_NAME", "NONPROFIT_MISSION",
    ],
    links: ["BREWERY", "BREWERY_LINK", "EVENTBRITE", "NONPROFIT", "NONPROFIT_LINK"],
  },
  details: {
    templateId: 0,
    titleSuffix: "Event Details",
    subjectLine: "Details for {{ BREWERY_NAME }} this weekend",
    tokens: [
      "BREWERY_NAME", "CITY_NAME", "EVENT_DATE", "EVENT_TIME",
      "EVENT_TIME_CHECKIN", "EVENT_TIME_RAFFLE", "BREWERY_ADDRESS",
      "PARKING_INFO", "PUBLIC_TRANSIT_INFO", "QUESTION_OF_THE_DAY",
      "CTA_RUN_AGAIN", "NONPROFIT_NAME", "NONPROFIT_MISSION",
    ],
    links: ["BREWERY", "BREWERY_LINK", "BREWERY_ADDRESS", "EVENTBRITE", "MAPMYRUN", "NONPROFIT"],
  },
  recap: {
    templateId: 0,
    titleSuffix: "Recap",
    subjectLine: "Thanks for coming out to {{ BREWERY_NAME }}!",
    tokens: [
      "BREWERY_NAME", "CITY_NAME", "EVENT_ALBUM", "PARTNER_LIST", "NONPROFIT_NAME",
      "NEXT_BREWERY_NAME", "NEXT_CITY_NAME", "NEXT_EVENT_DATE",
      "NEXT_EVENT_TIME", "NEXT_EVENT_PROMO",
    ],
    links: ["EVENT_ALBUM", "NEXT_EVENT", "NONPROFIT"],
  },
};

// Sender info applied to every campaign so the drafts are send-ready.
const FROM_NAME = "MA Brewery Running Series";
const REPLY_TO  = "you@example.com";

// Prompts for {{ }} text tokens. `default` may be a function of (eventName, values).
const TOKEN_PROMPTS = {
  BREWERY_NAME:        { label: "Brewery / venue name", default: (ev) => ev },
  CITY_NAME:           { label: "Event city" },
  EVENT_DATE:          { label: "Event date" },
  EVENT_TIME:          { label: "Event start time" },
  EVENT_TIME_CHECKIN:  { label: "Check-in time" },
  EVENT_TIME_RAFFLE:   { label: "Raffle time" },
  BREWERY_ADDRESS:     { label: "Brewery address" },
  BREWERY_ABOUT:       { label: "About the brewery (short paragraph)" },
  PROMO_COPY:          { label: "Promo / discount blurb" },
  PARKING_INFO:        { label: "Parking info" },
  PUBLIC_TRANSIT_INFO: { label: "Public transit info" },
  QUESTION_OF_THE_DAY: { label: "Question of the day" },
  CTA_RUN_AGAIN:       { label: "'Run again' CTA lead-in" },
  NONPROFIT_NAME:      { label: "Nonprofit beneficiary" },
  NONPROFIT_MISSION:   { label: "Nonprofit mission (one line)" },
  EVENT_ALBUM:         { label: "Photo album link text (shown to readers)" },
  PARTNER_LIST:        { label: "Partner list (e.g. 'X, Y, and Z')" },
  NEXT_BREWERY_NAME:   { label: "Next event brewery/venue" },
  NEXT_CITY_NAME:      { label: "Next event city" },
  NEXT_EVENT_DATE:     { label: "Next event date" },
  NEXT_EVENT_TIME:     { label: "Next event start time" },
  NEXT_EVENT_PROMO:    { label: "Next event promo code" },
};

// Prompts for https://NAME.LINK placeholders. Duplicate-named links alias to one.
const LINK_PROMPTS = {
  BREWERY:         { label: "Brewery website URL" },
  BREWERY_LINK:    { label: "Brewery website URL (duplicate name)", default: (ev, L) => L.BREWERY },
  BREWERY_ADDRESS: { label: "Brewery map / directions URL" },
  EVENTBRITE:      { label: "Eventbrite registration URL" },
  MAPMYRUN:        { label: "Run route (MapMyRun) URL" },
  NONPROFIT:       { label: "Nonprofit website URL" },
  NONPROFIT_LINK:  { label: "Nonprofit website URL (duplicate name)", default: (ev, L) => L.NONPROFIT },
  EVENT_ALBUM:     { label: "Event photo album URL" },
  NEXT_EVENT:      { label: "Next event registration URL" },
};

// ─── Mailchimp request helper ────────────────────────────────────────────────

const API_KEY = process.env.MAILCHIMP_API_KEY;
const LIST_ID = process.env.MAILCHIMP_AUDIENCE_ID;

if (!API_KEY) { console.error("Missing MAILCHIMP_API_KEY"); process.exit(1); }
const DC = API_KEY.split("-")[1];
if (!DC) { console.error("Could not derive data center from API key"); process.exit(1); }

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
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Placeholder helpers ─────────────────────────────────────────────────────

// Replace {{ TOKEN }} (space-tolerant) and https://NAME.LINK. Uses a function
// replacer so values containing $ (e.g. "$10 off") are inserted literally.
function fillPlaceholders(text, textValues, linkValues) {
  let out = text;
  for (const [key, value] of Object.entries(textValues)) {
    out = out.replace(new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g"), () => value);
  }
  for (const [name, url] of Object.entries(linkValues)) {
    out = out.split("https://" + name + ".LINK").join(url);
  }
  return out;
}

// Any placeholders still present after filling.
function findLeftovers(text) {
  const t = [...text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => `{{ ${m[1]} }}`);
  const l = [...text.matchAll(/https:\/\/([A-Za-z0-9_]+)\.LINK/g)].map((m) => `https://${m[1]}.LINK`);
  return [...new Set([...t, ...l])];
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Prompt for a set of keys using the given prompt map; returns a values object.
async function gather(keys, promptMap, eventName, header) {
  const values = {};
  if (!keys.size) return values;
  console.log(`\n${header}`);
  for (const key of keys) {
    const cfg = promptMap[key] || { label: key };
    const def = typeof cfg.default === "function" ? cfg.default(eventName, values) : cfg.default;
    const answer = await prompt(`  ${cfg.label}${def ? ` [${def}]` : ""}: `);
    const value = answer || def;
    if (value) values[key] = value;
  }
  return values;
}

// Look up a tag's numeric static-segment id by exact name.
async function resolveTagId(name) {
  let offset = 0;
  const count = 1000;
  while (true) {
    const res = await mcRequest("GET", `/lists/${LIST_ID}/segments?type=static&count=${count}&offset=${offset}`);
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

// Build segment_opts for each campaign type from the two resolved tag ids.
function segmentOpts(type, eventTagId, volunteerTagId) {
  const cond = (op, value) => ({ condition_type: "StaticSegment", field: "static_segment", op, value });
  switch (type) {
    case "friend":
      return { match: "all", conditions: [cond("static_not", eventTagId), cond("static_not", volunteerTagId)] };
    case "details":
      return { match: "all", conditions: [cond("static_is", eventTagId)] };
    case "recap":
      return { match: "any", conditions: [cond("static_is", eventTagId), cond("static_is", volunteerTagId)] };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list-templates")) {
    const res = await mcRequest("GET", "/templates?type=user&count=100&fields=templates.id,templates.name");
    for (const t of res.body.templates ?? []) console.log(`${t.id}\t${t.name}`);
    return;
  }

  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const eventName = positional[0];
  if (!eventName) {
    console.error('Usage: node create-campaigns.js "Event Name" [--year YYYY] [--dry-run]');
    process.exit(1);
  }
  if (!LIST_ID) { console.error("Missing MAILCHIMP_AUDIENCE_ID"); process.exit(1); }

  const yearIdx = args.indexOf("--year");
  const year = yearIdx !== -1 ? args[yearIdx + 1] : String(new Date().getFullYear());

  const eventTag = `${year} ${eventName}`;
  const volunteerTag = `${year} ${eventName} Volunteer`;

  console.log(`Event:         ${eventName}`);
  console.log(`Event tag:     ${eventTag}`);
  console.log(`Volunteer tag: ${volunteerTag}`);

  // Resolve both tags to segment ids up front so we fail fast on typos.
  const eventTagId = await resolveTagId(eventTag);
  const volunteerTagId = await resolveTagId(volunteerTag);
  if (!eventTagId)     { console.error(`Tag not found: "${eventTag}"`); process.exit(1); }
  if (!volunteerTagId) { console.error(`Tag not found: "${volunteerTag}"`); process.exit(1); }
  console.log(`Resolved "${eventTag}" -> ${eventTagId}`);
  console.log(`Resolved "${volunteerTag}" -> ${volunteerTagId}`);

  const plan = [
    { type: "friend",  ...TEMPLATES.friend },
    { type: "details", ...TEMPLATES.details },
    { type: "recap",   ...TEMPLATES.recap },
  ];

  // Prompt only for placeholders used by templates that have an id set.
  const tokenSet = new Set();
  const linkSet = new Set();
  for (const c of plan) {
    if (!c.templateId) continue;
    for (const t of (c.tokens || [])) tokenSet.add(t);
    for (const l of (c.links || [])) linkSet.add(l);
  }

  const textValues = await gather(tokenSet, TOKEN_PROMPTS, eventName, "Text (blank = leave for later):");
  const linkValues = await gather(linkSet, LINK_PROMPTS, eventName, "Links — paste full URLs (blank = leave for later):");

  for (const c of plan) {
    const title = `${year} ${eventName} – ${c.titleSuffix}`;
    const subject = fillPlaceholders(c.subjectLine, textValues, linkValues);
    const opts = segmentOpts(c.type, eventTagId, volunteerTagId);

    console.log(`\n── ${title} ──`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Segment: match=${opts.match}, ${opts.conditions.map((x) => `${x.op}(${x.value})`).join(", ")}`);

    if (!c.templateId) { console.warn(`  ⚠ No templateId set for "${c.type}" — skipping. Set it in CONFIG.`); continue; }
    if (dryRun) { console.log("  (dry run — not created)"); continue; }

    // 1. Create the draft from the saved template.
    const created = await mcRequest("POST", "/campaigns", {
      type: "regular",
      recipients: { list_id: LIST_ID, segment_opts: opts },
      settings: {
        subject_line: subject,
        title,
        from_name: FROM_NAME,
        reply_to: REPLY_TO,
        template_id: c.templateId,
        auto_footer: false,
      },
    });
    if (created.status >= 400) {
      console.error("  ✗ Create failed:", created.body?.detail || created.body);
      continue;
    }
    const campaignId = created.body.id;

    // 2. Pull rendered HTML, fill placeholders, push back up.
    const content = await mcRequest("GET", `/campaigns/${campaignId}/content`);
    const html = fillPlaceholders(content.body.html || "", textValues, linkValues);
    const leftover = findLeftovers(html);
    if (leftover.length) console.warn(`  ⚠ Unfilled: ${leftover.join(", ")}`);

    const put = await mcRequest("PUT", `/campaigns/${campaignId}/content`, { html });
    if (put.status >= 400) {
      console.error("  ✗ Content update failed:", put.body?.detail || put.body);
      continue;
    }
    console.log(`  ✓ Draft created (${campaignId}) — review at https://${DC}.admin.mailchimp.com/campaigns/`);
  }

  console.log("\nDone. All three are drafts — review and send from Mailchimp.");
}

main().catch((err) => { console.error("Unexpected error:", err); process.exit(1); });
