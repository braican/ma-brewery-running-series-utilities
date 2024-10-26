import { Client } from "@notionhq/client";
import { config } from "dotenv";
import ProgressBar from "cli-progress";

config();

// Initializing a client
const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

const DB_ID = process.env.NOTION_MA_BREWERY_DB_ID;

async function fetchBreweries() {
  let allBreweries = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `https://api.openbrewerydb.org/v1/breweries?by_state=massachusetts&per_page=100&page=${page}`
    );
    const breweries = await response.json();

    if (breweries.length === 0) {
      break;
    }

    allBreweries = [...allBreweries, ...breweries];
    page++;
  }

  return allBreweries;
}

async function addBreweryToNotion(brewery) {
  const properties = {
    Name: {
      type: "title",
      title: [{ type: "text", text: { content: brewery.name } }],
    },
    Address: {
      type: "rich_text",
      rich_text: [{ type: "text", text: { content: brewery.street || "" } }],
    },
    Town: {
      type: "select",
      select: { name: brewery.city || "No town" },
    },
    "Zip code": {
      type: "rich_text",
      rich_text: [
        { type: "text", text: { content: brewery.postal_code || "" } },
      ],
    },
    "Phone number": {
      phone_number: brewery.phone,
    },
    Website: {
      url: brewery.website_url,
    },
    Type: {
      type: "select",
      select: { name: brewery.brewery_type || "None" },
    },
    Latitude: {
      type: "rich_text",
      rich_text: [{ type: "text", text: { content: brewery.latitude || "" } }],
    },
    Longitude: {
      type: "rich_text",
      rich_text: [{ type: "text", text: { content: brewery.longitude || "" } }],
    },
  };

  const { results } = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      property: "ID",
      rich_text: {
        equals: brewery.id,
      },
    },
  });

  // If there was a returned record, just update it.
  if (results.length > 0) {
    return await notion.pages.update({
      page_id: results[0].id,
      properties,
    });
  }

  // Otherwise it's brand new, and we should add the ID.
  properties.ID = {
    type: "rich_text",
    rich_text: [{ type: "text", text: { content: brewery.id } }],
  };

  return notion.pages.create({
    parent: {
      database_id: DB_ID,
    },
    properties,
  });
}

async function main() {
  const breweries = await fetchBreweries();
  console.log(`Importing ${breweries.length} breweries`);

  const pb = new ProgressBar.SingleBar({}, ProgressBar.Presets.shades_classic);
  pb.start(breweries.length, 0);

  for (const brewery of breweries) {
    await addBreweryToNotion(brewery);
    pb.increment();
  }

  pb.stop();

  console.log("All imported.");
}

main();
