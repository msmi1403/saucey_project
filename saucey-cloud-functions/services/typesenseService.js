const Typesense = require("typesense");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const functions = require('firebase-functions'); // For logger
const logger = functions.logger;

const secretClient = new SecretManagerServiceClient();

// Re-using the getSecretValue function from the original index.js
async function getSecretValue(secretName) {
    try {
        const projectId = process.env.GCLOUD_PROJECT || functions.config().project.id;
        if (!projectId) {
            logger.error("FATAL: Google Cloud Project ID could not be determined.");
            throw new Error("Google Cloud Project ID not found.");
        }
        const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
        const [version] = await secretClient.accessSecretVersion({ name: name });
        const payload = version.payload.data.toString("utf8");
        logger.log(`Successfully retrieved secret: ${secretName}`);
        return payload;
    } catch (error) {
        logger.error(`Error retrieving secret ${secretName}:`, error);
        throw error; 
    }
}

let typesenseSearchClientInternal = null;
let typesenseAdminClientInternal = null;

const RECIPES_COLLECTION_NAME = "public_recipes"; // As defined in original index.js

// --- Typesense Schema Definition (moved from functions/index.js) ---
const recipeSchema = {
  name: RECIPES_COLLECTION_NAME, // Use the constant defined in this file
  fields: [
    { name: "title", type: "string", index: true },
    { name: "recipeId", type: "string", index: false }, // recipeId from Firestore doc ID
    { name: "createdByUsername", type: "string", facet: true, optional: true },
    { name: "imageURL", type: "string", index: false, optional: true },
    { name: "cuisine", type: "string", facet: true, optional: true },
    { name: "tags", type: "string[]", facet: true, optional: true },
    { name: "saveCount", type: "int64", sort: true, default: 0 },
    { name: "averageRating", type: "float", sort: true, optional: true },
    { name: "reviewCount", type: "int64", optional: true, default: 0 },
    { name: "createdAt", type: "int64", sort: true, optional: true }, // Firestore timestamp (seconds)
    { name: "isPublic", type: "bool", facet: true },
    { name: "difficulty", type: "string", facet: true, optional: true },
    { name: "category", type: "string", facet: true, optional: true },
    { name: "total_time", type: "string", optional: true, index: false },
  ],
  default_sorting_field: "saveCount",
};

const typesenseInitializationPromise = (async () => {
    try {
        logger.log("Initializing Typesense clients...");
        const host = await getSecretValue("TYPESENSE_HOST");
        const port = await getSecretValue("TYPESENSE_PORT");
        const protocol = await getSecretValue("TYPESENSE_PROTOCOL");
        
        const searchApiKey = await getSecretValue("TYPESENSE_SEARCH_API_KEY");
        const adminApiKey = await getSecretValue("TYPESENSE_ADMIN_API_KEY");

        typesenseSearchClientInternal = new Typesense.Client({
            nodes: [{ host, port: parseInt(port, 10), protocol }],
            apiKey: searchApiKey,
            connectionTimeoutSeconds: 5,
        });
        logger.log("Typesense SEARCH client initialized successfully.");

        typesenseAdminClientInternal = new Typesense.Client({
            nodes: [{ host, port: parseInt(port, 10), protocol }],
            apiKey: adminApiKey,
            connectionTimeoutSeconds: 10, 
        });
        logger.log("Typesense ADMIN client initialized successfully.");

    } catch (error) {
        logger.error("FATAL: Failed to initialize Typesense clients:", error);
        typesenseSearchClientInternal = null; 
        typesenseAdminClientInternal = null;
        // We might want to throw the error here so functions attempting to use it fail fast
        // or handle the null clients gracefully in the calling functions.
        // For now, functions will get null if this fails.
    }
})();

// --- Helper to Ensure Collection Exists (moved from functions/index.js) ---
async function ensureTypesenseCollectionExists(client) {
  if (!client) {
    logger.error("ensureTypesenseCollectionExists: FATAL - Typesense client not provided.");
    throw new Error("Typesense client not provided to ensureTypesenseCollectionExists.");
  }
  try {
    logger.info(`ensureTypesenseCollectionExists: Checking for collection '${RECIPES_COLLECTION_NAME}'.`);
    await client.collections(RECIPES_COLLECTION_NAME).retrieve();
    logger.info(`ensureTypesenseCollectionExists: Collection '${RECIPES_COLLECTION_NAME}' already exists.`);
  } catch (retrieveError) {
    if (retrieveError.httpStatus === 404) { // More specific check for ObjectNotFound
      logger.info(`ensureTypesenseCollectionExists: Collection '${RECIPES_COLLECTION_NAME}' not found, attempting creation.`);
      try {
        await client.collections().create(recipeSchema); 
        logger.info(`ensureTypesenseCollectionExists: Successfully CREATED collection '${RECIPES_COLLECTION_NAME}'.`);
      } catch (createError) {
        logger.error(`ensureTypesenseCollectionExists: FAILED to CREATE collection '${RECIPES_COLLECTION_NAME}':`, createError);
        throw new Error(`Failed to create Typesense collection: ${createError.message}`); 
      }
    } else {
      logger.error(`ensureTypesenseCollectionExists: Error retrieving collection '${RECIPES_COLLECTION_NAME}' (not 404):`, retrieveError);
      throw new Error(`Failed to retrieve Typesense collection info: ${retrieveError.message}`);
    }
  }
}

// Getter functions to access the clients after initialization
function getTypesenseSearchClient() {
    if (!typesenseSearchClientInternal) {
        logger.warn("getTypesenseSearchClient: Search client requested before initialization or init failed.");
    }
    return typesenseSearchClientInternal;
}

function getTypesenseAdminClient() {
    if (!typesenseAdminClientInternal) {
        logger.warn("getTypesenseAdminClient: Admin client requested before initialization or init failed.");
    }
    return typesenseAdminClientInternal;
}

module.exports = {
    typesenseInitializationPromise,
    getTypesenseSearchClient,
    getTypesenseAdminClient,
    RECIPES_COLLECTION_NAME,
    recipeSchema, // Export schema
    ensureTypesenseCollectionExists, // Export helper function
    getSecretValue, // Also export getSecretValue as it's used by sync function directly
}; 