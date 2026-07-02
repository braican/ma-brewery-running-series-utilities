# Mailchimp API notes — campaign creation & content

A decision record for `create-campaigns/index.js`. Everything here was verified
empirically against the live account (us8 data center). The short version: the
Marketing API is built around the **classic** builder, our templates are
**new-builder**, and that mismatch dictates what's possible.

## Goal

Per event, produce three draft campaigns — Invite a Friend, Event Details, Recap
— each with the correct audience and, ideally, template + content pre-filled from
`{{ TOKEN }}` / `https://NAME.LINK` placeholders. Owner requires Mailchimp's
new-builder asset management (drag-drop images), so raw-HTML campaigns are not
acceptable as the final form.

## What was tried, in order, and the result

1. **`settings.template_id` at campaign creation.**
   Created the campaign but content came back as Mailchimp's default filler, not
   our design. Conclusion: `settings.template_id` does not populate content.

2. **Create from template, read HTML back, fill, `PUT` raw `html`.**
   Depends on step 1 loading the template; since it doesn't, this filled nothing
   and pushed generic content back. Also: `PUT .../content { html }` produces a
   **legacy coded** campaign (only the classic/legacy builder can hold
   custom-coded HTML), which loses new-builder asset management. Rejected.

3. **Local template HTML files + fill + `PUT html`.**
   Reliable and rendered correctly (images are already hosted on Mailchimp's CDN
   and referenced by URL, so they display). But still a legacy coded campaign —
   same asset-management objection. The fill logic itself is solid and worth
   keeping if we ever go classic (Twig `{{ }}` matching is newline-tolerant;
   replacement uses a function replacer so values with `$` insert literally;
   leftover placeholders are detected and reported).

4. **`PUT .../content { template: { id } }` (content-endpoint template param).**
   The documented way to apply a template. Confirmed the Templates API is
   **classic-only** ("Only Classic templates are supported"). Our templates are
   new-builder, so this assigned nothing — drafts came up blank/filler.
   `GET /templates/{id}/default-content` returns the editable sections for a
   template; for template 10001586 it returned **none**, confirming new-builder.

5. **`content_type: "multichannel"` in `POST /campaigns`.**
   **This works** — creates a genuine new-builder campaign (verified: the create
   response and read-back both report `content_type: multichannel`, and it opens
   in the new builder). Caveats discovered:
   - `settings.template_id` is still ignored — the draft opens blank asking you
     to pick a template.
   - `GET /campaigns/{id}/content` returns `html: ""` for multichannel — the
     content endpoint is blind to new-builder content, so the script cannot read
     or verify what's inside; only the builder UI shows it.
   - There is no API path to author/write multichannel content.

6. **Keep a hand-built new-builder "template draft" and `replicate` it per event**
   (then re-point audience/subject via `PATCH`).
   Attractive because replicate should deep-copy new-builder design + images.
   **Blocked upstream:** the new builder won't let you _save_ a draft that still
   has empty/placeholder image blocks, so you can't maintain a reusable master
   draft full of placeholders. Abandoned.

## Current design (consequence of the above)

`POST /campaigns` with:

```jsonc
{
  "type": "regular",
  "content_type": "multichannel",              // new builder
  "recipients": { "list_id": "...", "segment_opts": { ... } },
  "settings": {
    "subject_line": "...", "preview_text": "...", "title": "...",
    "from_name": "MA Brewery Running Series",
    "reply_to": "nick@breweryrunningseries.com",
    "template_id": 100015XX                    // ignored by multichannel; kept per owner's spec
  }
}
```

Then the owner, in the builder: picks the template, fills the tokens. The script
prints both reminders (template name + token checklist) with the edit URL.

## Audience / segment reference

Tags are static segments; resolve id by name via `GET /lists/{id}/segments?type=static`.

```js
// Invite a friend: NOT in either tag
{ match: "all", conditions: [static_not(eventTagId), static_not(volunteerTagId)] }
// Event details: in the event tag
{ match: "all", conditions: [static_is(eventTagId)] }
// Recap: in either tag
{ match: "any", conditions: [static_is(eventTagId), static_is(volunteerTagId)] }
// condition: { condition_type:"StaticSegment", field:"static_segment", op, value }
```

## Useful endpoints

- `GET /templates?type=user` — list user templates (id, name, type). `type` is
  `user` for these; note the Templates API surfaces classic-style entries.
- `GET /templates/{id}/default-content` — editable sections; empty ⇒ new builder.
- `POST /campaigns` — create; accepts `content_type`.
- `GET /campaigns?status=save` — list drafts (find/verify by `settings.title`).
- `POST /campaigns/{id}/actions/replicate` — deep-copies a campaign.
- `PATCH /campaigns/{id}` — update `recipients` and `settings` on a draft.
- `DELETE /campaigns/{id}` — remove a draft (use to clean up tests).

## If full automation becomes a priority

The only route to API-driven template + token fill is **classic templates**:
rebuild the three designs in the classic builder, then apply via
`PUT .../content { template: { id, sections: { <mc:edit name>: <filled html> } } }`.
Classic still has the file manager for images. Cost: one rebuild each, in a
builder Mailchimp is deprecating. Revive the step-3 fill logic to populate the
`sections`.
