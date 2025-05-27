// utils/fetchRecipeJsonLd.js

const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetch a schema.org Recipe object from a URL, even if nested under WebPage.mainEntity
 * or buried inside a @graph array.
 */
async function fetchRecipeJsonLd(url) {
  console.log(`WorkspaceRecipeJsonLd(): Starting to fetch from URL: ${url}`); // Log when the function starts

  // 1) Download the page
  let html;
  try {
    const response = await axios.get(url, { timeout: 10_000 });
    html = response.data;
    console.log(`WorkspaceRecipeJsonLd(): Successfully downloaded HTML from ${url}`);
  } catch (error) {
    console.error(`WorkspaceRecipeJsonLd(): Error downloading HTML from ${url}:`, error.message);
    throw new Error(`Failed to download HTML from ${url}: ${error.message}`); // Re-throw or handle as appropriate
  }

  const $ = cheerio.load(html);
  let recipe = null;

  // *** IDEAL PLACE FOR YOUR DEBUGGING LOGS ***
  const scriptElements = $('script[type="application/ld+json"]'); // Get all script elements
  console.log(`WorkspaceRecipeJsonLd(): Found ${scriptElements.length} JSON-LD <script> tags on the page.`);

  // 2) Inspect every JSON-LD <script> tag
  scriptElements.each((index, element) => { // Use the 'scriptElements' variable from above
    console.log(`WorkspaceRecipeJsonLd(): Processing script tag #${index + 1}`);
    try {
      const jsonText = $(element).html().trim();
      if (!jsonText) {
        console.log(`WorkspaceRecipeJsonLd(): Script tag #${index + 1} is empty.`);
        return; // skip empty blocks
      }
      //console.log(`WorkspaceRecipeJsonLd(): Raw JSON-LD from script #${index + 1}:`, jsonText.substring(0, 100) + '...'); // Log a snippet

      const obj = JSON.parse(jsonText);
      // console.log(`WorkspaceRecipeJsonLd(): Parsed JSON object from script #${index + 1}:`, obj); // Potentially very verbose

      // 3) Flatten top-level arrays, @graph arrays, or wrap single objects
      const items = Array.isArray(obj)
        ? obj
        : (obj['@graph'] && Array.isArray(obj['@graph']))
          ? obj['@graph']
          : [obj];
      console.log(`WorkspaceRecipeJsonLd(): Number of items to check in script #${index + 1}: ${items.length}`);

      // 4) Look for Recipe in items or under mainEntity
      for (const item of items) {
        // direct Recipe?
        const t = item['@type'];
        const isRecipeType = (type) => 
          (typeof type === 'string' && type.toLowerCase() === 'recipe') ||
          (Array.isArray(type) && type.map(x => x.toLowerCase()).includes('recipe'));

        if (isRecipeType(t)) {
          console.log(`WorkspaceRecipeJsonLd(): Found direct Recipe object in script #${index + 1}.`);
          recipe = item;
          return false; // break out of .each()
        }

        // nested under mainEntity?
        if (item.mainEntity) {
          const me = item.mainEntity;
          const mt = me['@type'];
          if (isRecipeType(mt)) {
            console.log(`WorkspaceRecipeJsonLd(): Found Recipe object nested under mainEntity in script #${index + 1}.`);
            recipe = me;
            return false; // break out of .each()
          }
        }
      }
    } catch (e) {
      //console.warn(`WorkspaceRecipeJsonLd(): Error parsing JSON-LD from script tag #${index + 1}:`, e.message);
      // ignore malformed JSON for now, or decide if you want to be stricter
    }
  });

  // 5) If still nothing, error out
  if (!recipe) {
    console.warn(`WorkspaceRecipeJsonLd(): No Recipe object found after checking all script tags for ${url}.`);
    throw new Error(
      'No <script type="application/ld+json"> with a Recipe object found on page'
    );
  }

  console.log(`WorkspaceRecipeJsonLd(): Successfully found Recipe object for ${url}.`);
  return recipe;
}

module.exports = { fetchRecipeJsonLd };