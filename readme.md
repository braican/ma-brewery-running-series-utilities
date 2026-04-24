# Massachusetts Brewery Running Series utilities

Utilities and scripts in service of management of the Massachusetts location for the Brewery Running Series.

## Notion Sync

Usage:

```sh
node notion-sync/import.js
```

## Eventbrite/Mailchimp Sync

### Sync

Usage:

```sh
# Sync contacts from the report into Mailchimp with the "Winch and Pulley" tag.
node eventbrite-mailchimp-sync/sync.js report.csv "Winch and Pulley"

# Sync contacts from the report into Mailchimp with the "Winch and Pulley" tag with a year override.
node eventbrite-mailchimp-sync/sync.js report.csv "Winch and Pulley" --year 2025

# Sync contacts from the report into Mailchimp with the "Winch and Pulley" tag with a year override.
node eventbrite-mailchimp-sync/sync.js report.csv "Winch and Pulley" --dry-run
```

### Get registrants

Usage:

```sh
# Get runners with the "Winch and Pulley" tag.
node get-registrants.js "Winch and Pulley"

# Get runners and volunteers with the "Winch and Pulley" tag.
node get-registrants.js "Winch and Pulley" --volunteers

# Get runners and volunteers with the "Winch and Pulley" tag, excluding recipients of selected campaigns.
node get-registrants.js "Winch and Pulley" --exclude-campaign
```
