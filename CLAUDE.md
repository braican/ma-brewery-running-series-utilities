# MA Brewery Running Series Utilities

Node.js utilities that automate recurring Mailchimp work for MA Brewery Running
Series (BRS) events. This file orients an agent working in the repo; deeper
Mailchimp API findings live in `create-campaigns/MAILCHIMP-NOTES.md` — **read it
before changing anything about how campaigns or content are created.**

## Repo conventions

- **ESM.** `package.json` has `"type": "module"`; use `import`, not `require`.
  (`.js` files are ES modules; a stray `require` throws at runtime.)
- **Minimal dependencies.** Standard library only, plus `dotenv`. Don't add the
  Mailchimp SDK or an HTTP client — the existing `mcRequest` helper (built on
  `node:https`) is the house style; match it.
- **Config via env**, loaded with `import "dotenv/config";` as the first import
  so vars are present before any module-level `process.env` read.
  - `MAILCHIMP_API_KEY` — data center is derived from its suffix:
    `const DC = API_KEY.split("-")[1]` → requests go to
    `https://${DC}.api.mailchimp.com/3.0`.
  - `MAILCHIMP_AUDIENCE_ID` — the target list id.

## Scripts

- `create-campaigns/index.js` — creates the three per-event draft campaigns
  (see below). Run: `node ./create-campaigns "Event Name" [--year YYYY] [--dry-run]`.
- Pre-existing (not documented here in depth): an Eventbrite→Mailchimp sync that
  tags registrants, and a registrants lookup. They share the same env vars, DC
  derivation, and `mcRequest` pattern.

## Domain model

Every event gets two Mailchimp **tags** (which are static segments under the hood):

- `{year} {Event Name}` — attendees
- `{year} {Event Name} Volunteer` — volunteers

Example for 2026 Aeronaut: `2026 Aeronaut`, `2026 Aeronaut Volunteer`.

Tag → segment id is resolved by name via
`GET /lists/{id}/segments?type=static` (paginate; match on `name`).

## The three campaigns and their audiences

| Campaign        | Audience                                    | segment_opts                               |
| --------------- | ------------------------------------------- | ------------------------------------------ |
| Invite a friend | everyone EXCEPT event tag AND volunteer tag | `match:"all"`, two `static_not` conditions |
| Event details   | only the event tag                          | `match:"all"`, one `static_is` condition   |
| Recap           | event tag OR volunteer tag                  | `match:"any"`, two `static_is` conditions  |

StaticSegment condition shape:

```js
{ condition_type: "StaticSegment", field: "static_segment", op: "static_is" | "static_not", value: <segmentId> }
```

## Templates (Mailchimp, NEW builder)

| id       | name                        |
| -------- | --------------------------- |
| 10001585 | MA BRS 2026 Invite a Friend |
| 10001586 | MA BRS 2026 Event Details   |
| 10001587 | MA BRS 2026 Event Recap     |

Template placeholders use Twig `{{ TOKEN }}` (space- and newline-tolerant) for
text and `https://NAME.LINK` for hyperlinks. These are filled **by hand in the
builder** in the current workflow — see constraints.

## What `create-campaigns/index.js` does today

1. Resolves the two tags for the event to segment ids (fails fast if missing).
2. Prompts for per-event values used in subjects / preview text / titles:
   `breweryNameShort` (defaults to the event arg), `breweryName`, `breweryCity`,
   `eventDateShort`, `dayOfWeek`, and recap-only `nextEventBrewery`,
   `nextEventCity`, `nextEventDate` (blanks allowed).
3. Creates three **`content_type: "multichannel"`** (new-builder) drafts via
   `POST /campaigns`, each with the correct `segment_opts` and with
   `subject_line`, `preview_text`, `title`, `from_name`, `reply_to`, `template_id`.
4. Prints, per draft, which template to pick and the token checklist to fill,
   plus a direct builder edit URL.

Generated per campaign (interpolated from the prompt values):

- **Invite a friend** — subject `We're gearing up for our next run at {breweryNameShort} in {breweryCity}!`; preview `🍻 Run with us at {breweryName} this weekend, {eventDateShort}!`; title `MA {year} - {breweryNameShort} - Invite a friend`.
- **Event details** — subject `Event Details: {dayOfWeek} fun run at {breweryName}!`; preview `🏃‍♀️‍➡️ Get ready! ... at {breweryNameShort}!`; title `MA {year} - {breweryNameShort} - Event Details`.
- **Recap** — subject `Thanks for running with us at {breweryNameShort}! 🏃‍♀️`; preview `Next up – {nextEventBrewery} in {nextEventCity} on {nextEventDate}!`; title `MA {year} - {breweryNameShort} - Recap`.

`from_name` = `MA Brewery Running Series`; `reply_to` = `nick@breweryrunningseries.com`.

### Manual steps that remain (and why)

After the script runs, in the Mailchimp builder for each draft you must: **(1)
pick the template, (2) fill the token values.** The API cannot do either for
new-builder campaigns — this is a platform limit, not a TODO. See notes.

## Critical constraints — do NOT re-attempt these

These were each tried and confirmed broken. Full detail in
`create-campaigns/MAILCHIMP-NOTES.md`.

- `settings.template_id` does **not** load content into a campaign. Alone it
  yields blank/default drafts.
- `PUT /campaigns/{id}/content` with raw `html` works but makes a **legacy
  coded** campaign — loses new-builder asset management. Rejected by the owner.
- `PUT /campaigns/{id}/content` with `template:{id}` only attaches **classic**
  templates. These templates are new-builder, so it does nothing.
- `content_type: "multichannel"` **does** create a real new-builder campaign
  (this is the current approach), but for such campaigns the API cannot attach a
  template or write content, and `GET /content` returns empty.
- New builder refuses to **save** a draft containing empty/placeholder image
  blocks, so a reusable "template draft" that the script could `replicate` is not
  viable.

Net: the API's role is capped at creating new-builder drafts with the right
audience + settings. Template selection and content entry are manual.

## Verification checklist (first run / after changes)

- Open one created draft and confirm the **recipient count / segment** looks
  right — the `segment_opts` logic is the script's main value and the
  `multichannel` + `segment_opts` combo is worth eyeballing.
- Confirm subjects/preview/titles interpolated correctly (`--dry-run` prints all
  three without creating anything).
- Delete any leftover test/broken campaigns.

## Possible future directions

- **Full automation would require classic templates.** Rebuilding the three
  designs in the classic builder would let the API attach the template and fill
  tokens via the content endpoint's `sections` (keeping Mailchimp's file manager
  for images). Tradeoff: the classic builder is being sunset.
- The Twig `{{ }}` + `https://NAME.LINK` fill logic (newline-tolerant, `$`-safe
  string replacement, per-file leftover detection) was built during the
  HTML-fill iteration and can be revived if the classic route is taken.
