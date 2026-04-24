import { Client } from "@notionhq/client";
import { config } from "dotenv";
import ProgressBar from "cli-progress";

config();

// Initializing a client
const notion = new Client({
  auth: process.env.NOTION_SECRET,
});

const DB_ID = process.env.NOTION_MA_BREWERY_DB_ID;

/**
 * Fetch all MA breweries from the openbrewerydb. Note that this database is fairly
 * out of date; seems to have been last updated around 2022.
 *
 * @link https://www.openbrewerydb.org/
 */
async function fetchBreweriesFromOpenBreweryDb() {
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

async function getAllBreweriesFromNotion() {
  let cursor = undefined;
  let allBreweries = [];

  while (cursor !== null) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
    });

    allBreweries = [...allBreweries, ...results];
    cursor = next_cursor;
  }

  return allBreweries;
}

async function getSingleBreweryFromNotion(id) {
  try {
    return await notion.pages.retrieve({ page_id: id });
  } catch (e) {
    switch (e.status) {
      case 400:
        console.warn(
          "Validation error. Please be sure that you pass a valid page uuid."
        );
        break;
      case 404:
        console.warn("Page not found.");
        break;

      default:
        console.warn(
          `Something went wrong.\nStatus: ${e.status}\nCode: ${e.code}`
        );
        break;
    }

    return false;
  }
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

async function calculateDistanceTo(brewery) {
  const address = brewery.properties.Address.rich_text[0]?.plain_text;
  const town = brewery.properties.Town.select?.name;
  const state = brewery.properties.State.select?.name;
  const zip = brewery.properties["Zip code"].rich_text[0]?.plain_text;

  if (!address || !town) {
    return;
  }

  const breweryAddress = `${address}, ${town} ${state} ${zip}`;
  const homeAddress = "4 Moloney St, West Roxbury MA 02132";

  const matrixResponse = await fetch(
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(
      breweryAddress
    )}&destinations=${encodeURIComponent(homeAddress)}&units=imperial&key=${
      process.env.GOOGLE_CLOUD_API_KEY
    }`
  );

  const distanceData = await matrixResponse.json();
  const { distance, duration } = distanceData.rows[0]?.elements[0] || {};

  await notion.pages.update({
    page_id: brewery.id,
    properties: {
      "Drive time": {
        type: "rich_text",
        rich_text: [{ type: "text", text: { content: duration.text } }],
      },
      "Miles from home": {
        number: parseFloat(distance.text),
      },
    },
  });
}

async function importAll() {
  const pb = new ProgressBar.SingleBar({}, ProgressBar.Presets.shades_classic);
  const breweries = await getAllBreweriesFromNotion();

  // Helper to see db schema.
  // const response = await notion.databases.retrieve({ database_id: DB_ID });
  // console.log(response);

  pb.start(breweries.length, 0);

  for (const brewery of breweries) {
    await calculateDistanceTo(brewery);
    pb.increment();
  }

  pb.stop();
}

async function importSingle(id) {
  const record = await getSingleBreweryFromNotion(id);

  if (!record) {
    return;
  }

  await calculateDistanceTo(record);
}

const command = process.argv[2];

switch (command) {
  case "all":
    await importAll();
    break;
  case "single":
    const singleId = process.argv[3];

    if (!singleId) {
      console.log("Usage: node import.js single <recordId>");
      break;
    }

    await importSingle(singleId);
    break;
  default:
    console.log("Usage: node import.js [all|single]");
}
