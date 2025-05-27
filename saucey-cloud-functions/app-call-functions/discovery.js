const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin"); // For admin.firestore.Timestamp
const functions = require("firebase-functions"); // Added for logger
const { logger } = functions; // Added for logger

// Assuming admin is initialized (e.g., in root index.js)
const db = admin.firestore();

// --- Import shared utility functions ---
const { formatRecipeSummary } = require('../utils/recipeFormatters');

// --- Import Typesense Service ---
const { 
    typesenseInitializationPromise,
    getTypesenseSearchClient,
    RECIPES_COLLECTION_NAME
} = require('../services/typesenseService');

// --- Constants for discovery feed fetching ---
const DEFAULT_ITEMS_PER_CATEGORY = 7;

/**
 * Fetches a dynamic discovery feed composed of various recipe categories.
 * Categories are defined in the 'leaderboard_definitions' Firestore collection.
 */
const getDiscoveryFeed = onCall(async (request) => {
    const callerUid = request.auth ? request.auth.uid : null;
    const pageContext = request.data.pageContext || "mainDiscovery"; 
    const logPrefix = "getDiscoveryFeed:"; // Standardized prefix

    if (pageContext === "creatorProfileView") {
        logger.warn(
            `${logPrefix} Received 'creatorProfileView' context for pageContext: ${pageContext}, caller: ${callerUid || 'Guest'}. ` + // Changed to logger
            "This should be handled by 'getCreatorProfileData'. Returning empty."
        );
        return { feedTitle: "Discovery", categories: [] };
    }

    logger.info(`${logPrefix} Function started. Context: ${pageContext}, Caller: ${callerUid || 'Guest'}.`); // Changed to logger

    const feedResponse = {
        feedTitle: "Saucey Discovery", // Or make this dynamic based on context
        categories: [],
    };
    let categoryDefinitionSource = [];

    try {
        const definitionsSnapshot = await db
            .collection("leaderboard_definitions")
            .orderBy("displayOrder") // Assuming definitions have a displayOrder field
            .get();

        definitionsSnapshot.forEach((doc) => {
            categoryDefinitionSource.push({
                id: doc.id,
                ...doc.data(),
                // Ensure itemCount from definition is used, or fallback to default
                limit: doc.data().itemCount || DEFAULT_ITEMS_PER_CATEGORY,
            });
        });

        if (categoryDefinitionSource.length === 0) {
            logger.info(`${logPrefix} No category definitions found in 'leaderboard_definitions'. Context: ${pageContext}`); // Changed to logger
            return feedResponse; // Return empty feed if no definitions
        }

        for (const def of categoryDefinitionSource) {
            let recipes = [];
            let query;
            const fetchLimit = def.limit || DEFAULT_ITEMS_PER_CATEGORY;
            const defTypeLog = `Def: "${def.title}" (Type: ${def.type}, Limit: ${fetchLimit})`;
            logger.info(`${logPrefix} Processing ${defTypeLog}. Context: ${pageContext}`); // Changed to logger

            switch (def.type) {
                case "overall": // Example: Most popular overall
                case "trending": // Example: Currently trending (might use recentSaveCount later)
                    query = db.collection("public_recipes")
                        .where("isPublic", "==", true)
                        .orderBy(def.sortField || "saveCount", "desc") // Sort by defined field or saveCount
                        .orderBy("createdAt", "desc") // Secondary sort for tie-breaking
                        .limit(fetchLimit);
                    break;
                case "tagBased":
                    if (def.filterTags && Array.isArray(def.filterTags) && def.filterTags.length > 0) {
                        const tagsToQuery = def.filterTags.slice(0, 10); // Firestore limit for array-contains-any
                        query = db.collection("public_recipes")
                            .where("isPublic", "==", true)
                            .where("tags", "array-contains-any", tagsToQuery)
                            .orderBy(def.sortField || "saveCount", "desc")
                            .orderBy("createdAt", "desc")
                            .limit(fetchLimit);
                    } else {
                        logger.warn(`${logPrefix} tagBased category "${def.title}" is missing valid 'filterTags'. Context: ${pageContext}`); // Changed to logger
                    }
                    break;
                case "timeBased": // Example: New recipes from last X days
                    const now = admin.firestore.Timestamp.now();
                    const days = def.daysAgo && typeof def.daysAgo === 'number' ? def.daysAgo : 7;
                    const xDaysAgoTimestamp = admin.firestore.Timestamp.fromMillis(
                        now.toMillis() - days * 24 * 60 * 60 * 1000
                    );
                    query = db.collection("public_recipes")
                        .where("isPublic", "==", true)
                        .where("createdAt", ">=", xDaysAgoTimestamp)
                        .orderBy("createdAt", "desc")
                        .orderBy(def.sortField || "saveCount", "desc") // Secondary sort
                        .limit(fetchLimit);
                    break;
                default:
                    logger.warn(`${logPrefix} Unknown category definition type: "${def.type}" for "${def.title}". Skipping. Context: ${pageContext}`); // Changed to logger
                    break;
            }

            if (query) {
                const snapshot = await query.get();
                snapshot.forEach((doc) => {
                    const summary = formatRecipeSummary(doc.data(), doc.id);
                    if (summary) recipes.push(summary);
                });
            }

            if (recipes.length > 0) {
                feedResponse.categories.push({
                    id: def.id, // Include definition ID for client use if needed
                    title: def.title,
                    recipes: recipes,
                    // type: def.type, // Optionally pass the type back to the client
                    canLoadMore: recipes.length === fetchLimit, // Simple pagination hint
                });
            } else {
                logger.info(`${logPrefix} No recipes found for category "${def.title}". Context: ${pageContext}`); // Changed to logger
            }
        }

        const catCount = feedResponse.categories.length;
        logger.info(`${logPrefix} Prepared feed with ${catCount} categories. Context: ${pageContext}`); // Changed to logger
        return feedResponse;

    } catch (error) {
        logger.error(`${logPrefix} Error processing discovery feed. Context: ${pageContext}:`, error); // Changed to logger
        throw new HttpsError("internal", "Failed to get discovery feed.", error.message);
    }
});

/**
 * Searches public recipes using Typesense.
 * Requires authentication.
 */
const searchPublicRecipesWithTypesense = onCall(async (request) => {
    const logPrefix = "searchPublicRecipesWithTypesense:"; // Standardized prefix
    await typesenseInitializationPromise; // Ensure Typesense is initialized
    const typesenseSearchClient = getTypesenseSearchClient();

    if (!typesenseSearchClient) {
        logger.error(`${logPrefix} Typesense search client not available.`); // Changed to logger
        throw new HttpsError("unavailable", "Search service is currently unavailable. Please try again later.");
    }

    if (!request.auth) {
        logger.error(`${logPrefix} Authentication required.`); // Changed to logger
        throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    const callerUid = request.auth.uid;

    const query = request.data.query;
    if (!query || typeof query !== "string" || query.trim().length === 0) {
        logger.error(`${logPrefix} Search query is missing or invalid.`, { query, callerUid }); // Changed to logger
        throw new HttpsError("invalid-argument", "A non-empty 'query' string must be provided.");
    }
    
    const perPage = request.data.perPage || 30; // Allow client to specify, default to 30
    const page = request.data.page || 1; // Allow client to specify, default to 1

    logger.info(`${logPrefix} Processing search. Query:"${query}", Page:${page}, PerPage:${perPage}, User:${callerUid}.`); // Changed to logger

    const searchParameters = {
        "q": query,
        "query_by": "title,tags,cuisine,createdByUsername", // As defined in original function
        "filter_by": "isPublic:true",
        "sort_by": "_text_match:desc,saveCount:desc",
        "per_page": parseInt(perPage, 10),
        "page": parseInt(page, 10),
        // Potentially add facet_by, group_by etc. if needed by client
    };

    try {
        const searchResults = await typesenseSearchClient
            .collections(RECIPES_COLLECTION_NAME)
            .documents()
            .search(searchParameters);

        logger.info(`${logPrefix} Typesense search successful. Query:"${query}", Found:${searchResults.found}, Page:${searchResults.page}/${searchResults.out_of}, User:${callerUid}.`); // Changed to logger

        // Format results to match client expectations (RecipeSummary-like from formatRecipeSummary)
        const formattedHits = searchResults.hits.map((hit) => {
            const doc = hit.document; // This is the document from Typesense
            // The id field in Typesense is the Firestore document ID.
            // Use formatRecipeSummary, assuming Typesense doc has compatible fields.
            // If Typesense doc structure is very different, a specific formatter might be needed.
            return formatRecipeSummary(doc, doc.id || doc.recipeId); // Pass doc and its ID
        }).filter(Boolean); // Filter out any nulls if formatRecipeSummary returns null for bad data

        return {
            query: query,
            results: formattedHits,
            totalHits: searchResults.found,
            currentPage: searchResults.page,
            totalPages: Math.ceil(searchResults.found / searchParameters.per_page),
            hitsPerPage: searchParameters.per_page,
        };

    } catch (error) {
        logger.error(`${logPrefix} Error searching with Typesense. Query:"${query}", User:${callerUid}:`, error); // Changed to logger
        if (error.httpStatus) { // Handle Typesense specific errors
            throw new HttpsError("unavailable", `Search operation failed: ${error.message}`, { query });
        } else {
            throw new HttpsError("internal", "An unexpected error occurred during search.", { query });
        }
    }
});

module.exports = {
    getDiscoveryFeed,
    searchPublicRecipesWithTypesense,
}; 