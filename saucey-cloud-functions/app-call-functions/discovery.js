const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin"); // For admin.firestore.Timestamp

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
    // pageContext could be used for different feed variations if needed later
    const pageContext = request.data.pageContext || "mainDiscovery"; 

    // This check was in the original, good to keep if this specific context is handled elsewhere.
    if (pageContext === "creatorProfileView") {
        console.warn(
            "getDiscoveryFeed: Received 'creatorProfileView' context. " +
            "This should be handled by 'getCreatorProfileData'. Returning empty."
        );
        return { feedTitle: "Discovery", categories: [] };
    }

    const logPrefix = `getDiscoveryFeed[Context:${pageContext}, Caller:${callerUid || 'Guest'}]:`;
    console.log(`${logPrefix} Function started.`);

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
            console.log(`${logPrefix} No category definitions found in 'leaderboard_definitions'.`);
            return feedResponse; // Return empty feed if no definitions
        }

        for (const def of categoryDefinitionSource) {
            let recipes = [];
            let query;
            const fetchLimit = def.limit || DEFAULT_ITEMS_PER_CATEGORY;
            const defTypeLog = `Def: "${def.title}" (Type: ${def.type}, Limit: ${fetchLimit})`;
            console.log(`${logPrefix} Processing ${defTypeLog}`);

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
                        console.warn(`${logPrefix} tagBased category "${def.title}" is missing valid 'filterTags'.`);
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
                    console.warn(`${logPrefix} Unknown category definition type: "${def.type}" for "${def.title}". Skipping.`);
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
                console.log(`${logPrefix} No recipes found for category "${def.title}".`);
            }
        }

        const catCount = feedResponse.categories.length;
        console.log(`${logPrefix} Prepared feed with ${catCount} categories.`);
        return feedResponse;

    } catch (error) {
        console.error(`${logPrefix} Error processing discovery feed:`, error);
        throw new HttpsError("internal", "Failed to get discovery feed.", error.message);
    }
});

/**
 * Searches public recipes using Typesense.
 * Requires authentication.
 */
const searchPublicRecipesWithTypesense = onCall(async (request) => {
    await typesenseInitializationPromise; // Ensure Typesense is initialized
    const typesenseSearchClient = getTypesenseSearchClient();

    if (!typesenseSearchClient) {
        console.error("searchPublicRecipesWithTypesense: Typesense search client not available.");
        throw new HttpsError("unavailable", "Search service is currently unavailable. Please try again later.");
    }

    if (!request.auth) {
        console.error("searchPublicRecipesWithTypesense: Authentication required.");
        throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    // const callerUid = request.auth.uid; // Available if needed for logging or rules

    const query = request.data.query;
    if (!query || typeof query !== "string" || query.trim().length === 0) {
        console.error("searchPublicRecipesWithTypesense: Search query is missing or invalid.", { query });
        throw new HttpsError("invalid-argument", "A non-empty 'query' string must be provided.");
    }
    
    const perPage = request.data.perPage || 30; // Allow client to specify, default to 30
    const page = request.data.page || 1; // Allow client to specify, default to 1

    const logPrefix = `searchPublicRecipesWithTypesense[Query:"${query}", Page:${page}, PerPage:${perPage}]:`;
    console.log(`${logPrefix} Processing search by user ${request.auth.uid}.`);

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

        console.log(`${logPrefix} Found ${searchResults.found} total hits. Returning page ${searchResults.page} of ${searchResults.out_of} results.`);

        // Format results to match client expectations (RecipeSummary-like from formatRecipeSummary)
        const formattedHits = searchResults.hits.map((hit) => {
            const doc = hit.document;
            // We can reuse formatRecipeSummary here if the Typesense document structure is compatible
            // or create a dedicated formatter if fields differ significantly.
            // For now, assuming direct mapping and some defaults for fields not in Typesense doc.
            return {
                // recipeId is typically the 'id' field in Typesense documents
                recipeId: doc.id, 
                title: doc.title || null,
                imageURL: doc.imageURL || null,
                createdByUsername: doc.createdByUsername || null,
                // createdByUserId: doc.createdByUserId || null, // If you index this
                saveCount: doc.saveCount || 0,
                total_time: doc.total_time || null,
                averageRating: doc.averageRating || null,
                reviewCount: doc.reviewCount || 0,
                // These fields might not be in Typesense, ensure client handles nulls gracefully
                // or fetch full recipe data if detailed info is needed for search results.
                // For search, usually a summary is enough.
                // cuisine: doc.cuisine || null, // Already in query_by, so should be in doc
                // tags: doc.tags || [],     // Already in query_by, so should be in doc
                // isPublic: typeof doc.isPublic === 'boolean' ? doc.isPublic : false,
                // difficulty: doc.difficulty || null,
                // category: doc.category || null,
            };
        });

        return {
            results: formattedHits,
            totalResults: searchResults.found,
            totalPages: Math.ceil(searchResults.found / searchParameters.per_page),
            currentPage: searchResults.page,
        };

    } catch (error) {
        console.error(`${logPrefix} Error during Typesense search:`, error);
        // Check if it's a Typesense API error to provide more specific feedback
        if (error.httpStatus) {
            console.error(`${logPrefix} Typesense API Error: Status ${error.httpStatus}, Message: ${error.message}`);
            throw new HttpsError("unavailable", "Search service experienced an issue. Please try again.", error.message);
        }
        throw new HttpsError("internal", "Failed to perform search due to an unexpected error.", error.message);
    }
});

module.exports = {
    getDiscoveryFeed,
    searchPublicRecipesWithTypesense,
}; 