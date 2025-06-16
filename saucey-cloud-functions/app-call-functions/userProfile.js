const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2"); // Use Gen 2 logger

// Assuming admin is initialized (e.g., in root index.js)
const db = admin.firestore();

// --- Import shared utility functions ---
const { formatRecipeSummary } = require('../utils/recipeFormatters'); // Adjusted path

// --- Constants for profile data fetching ---
const DEFAULT_ITEMS_PER_CREATOR_CATEGORY = 7; // Default if definition doesn't specify itemCount

/**
 * Calculates the average rating of all public recipes created by the authenticated user.
 */
const getUserAveragePublicRating = onCall(async (request) => {
    const logPrefix = "getUserAveragePublicRating:"; // Standardized prefix

    if (!request.auth) {
        logger.error(`${logPrefix} Authentication required.`); // Changed to logger
        throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    const userId = request.auth.uid; // Recipes CREATED BY this user
    logger.info(`${logPrefix} Function started for user ${userId}.`); // Changed to logger and added userId

    let totalAverageRatingSum = 0;
    let publicRecipeCountWithRating = 0;

    try {
        const publicRecipesRef = db.collection("public_recipes");
        const userPublicRecipesQuery = publicRecipesRef
            .where("createdByUserId", "==", userId)
            .where("isPublic", "==", true);

        const publicRecipesSnapshot = await userPublicRecipesQuery.get();

        if (publicRecipesSnapshot.empty) {
            logger.info(`${logPrefix} User ${userId} has no public recipes.`); // Changed to logger and added userId
            return { averageRating: null, ratedRecipeCount: 0 }; 
        }

        publicRecipesSnapshot.forEach((recipeDoc) => {
            const recipeData = recipeDoc.data();
            if (typeof recipeData.averageRating === "number" && (recipeData.reviewCount || 0) > 0) {
                totalAverageRatingSum += recipeData.averageRating;
                publicRecipeCountWithRating++;
            }
        });

        const finalAverageRating = publicRecipeCountWithRating > 0 ?
            totalAverageRatingSum / publicRecipeCountWithRating :
            null;

        const result = {
            averageRating: finalAverageRating !== null ? parseFloat(finalAverageRating.toFixed(1)) : null,
            ratedRecipeCount: publicRecipeCountWithRating,
        };

        logger.info(`${logPrefix} Calculation complete for user ${userId}. Result:`, result); // Changed to logger and added userId
        return result;
    } catch (error) {
        logger.error(`${logPrefix} Error during calculation for user ${userId}:`, error); // Changed to logger and added userId
        throw new HttpsError("internal", "Failed to calc user's avg rating.", error.message);
    }
});

/**
 * Fetches public creator profile data for viewing creator profiles.
 * 
 * SECURITY NOTE: This function intentionally allows unauthenticated access
 * to support public profile viewing. Only public data is returned.
 * Authentication is optional - when provided, it may enable enhanced features
 * for logged-in users in the future.
 * 
 * @param {object} request.data.profileOwnerId - The user ID whose profile to fetch
 * @returns {object} Public profile data and categorized public recipes
 */
const getCreatorProfileData = onCall(async (request) => {
    const profileOwnerId = request.data.profileOwnerId;
    const callerUid = request.auth ? request.auth.uid : null; // Optional authentication for public profile viewing
    const logPrefix = "getCreatorProfileData:"; // Standardized prefix

    if (!profileOwnerId || typeof profileOwnerId !== "string") {
        logger.error(`${logPrefix} Missing or invalid 'profileOwnerId'.`, { profileOwnerId });
        throw new HttpsError("invalid-argument", "Valid 'profileOwnerId' is required.");
    }

    logger.info(`${logPrefix} Function started for profileOwnerId: ${profileOwnerId}, called by: ${callerUid || 'Anon'}.`);

    try {
        // --- 1. Fetch User Profile Info ---
        const userProfileRef = db.collection("users").doc(profileOwnerId);
        const userProfileSnap = await userProfileRef.get();

        let userProfileData = null;
        if (userProfileSnap.exists) {
            userProfileData = userProfileSnap.data();
            userProfileData.userId = userProfileSnap.id; 
            userProfileData.username = userProfileData.username || "User"; 
        } else {
            logger.info(`${logPrefix} User profile not found for ${profileOwnerId}.`);
        }

        // --- 2. Fetch Creator-Specific Category Definitions ---
        const recipeCategories = [];
        const categoryDefinitionSource = [];
        const definitionsSnapshot = await db
            .collection("leaderboard_definitions")
            .where("profileContext", "==", "creator") // Filter for creator profile categories
            .orderBy("displayOrder")
            .get();

        definitionsSnapshot.forEach((doc) => {
            categoryDefinitionSource.push({
                id: doc.id,
                ...doc.data(),
                limit: doc.data().itemCount || DEFAULT_ITEMS_PER_CREATOR_CATEGORY,
            });
        });
        
        if (categoryDefinitionSource.length === 0) {
            logger.info(`${logPrefix} No creator-specific category definitions found for ${profileOwnerId}.`);
            // Optionally, could fall back to a default "All Public Recipes" category here if desired
        }

        // --- 3. Fetch Recipes for Each Defined Category ---
        for (const def of categoryDefinitionSource) {
            let recipes = [];
            let query;
            const fetchLimit = def.limit || DEFAULT_ITEMS_PER_CREATOR_CATEGORY;
            const defTypeLog = `Def: "${def.title}" (Type: ${def.type}, Limit: ${fetchLimit}) for User: ${profileOwnerId}`;
            logger.info(`${logPrefix} Processing ${defTypeLog}.`);

            // Base query for this creator's public recipes
            let baseQuery = db.collection("public_recipes")
                .where("isPublic", "==", true)
                .where("createdByUserId", "==", profileOwnerId);

            switch (def.type) {
                case "creatorTagBased": // Recipes by this creator matching specific tags
                    if (def.filterTags && Array.isArray(def.filterTags) && def.filterTags.length > 0) {
                        const tagsToQuery = def.filterTags.slice(0, 10);
                        query = baseQuery
                            .where("tags", "array-contains-any", tagsToQuery)
                            .orderBy(def.sortField || "saveCount", "desc")
                            .orderBy("createdAt", "desc") // Secondary sort
                            .limit(fetchLimit);
                    } else {
                        logger.warn(`${logPrefix} creatorTagBased category "${def.title}" is missing 'filterTags'.`);
                    }
                    break;
                case "creatorOverallSort": // All recipes by this creator, sorted by a field (e.g. saveCount, createdAt)
                    query = baseQuery
                        .orderBy(def.sortField || "saveCount", "desc")
                        .orderBy("createdAt", "desc") // Ensure consistent secondary sort
                        .limit(fetchLimit);
                    break;
                // Add more creator-specific types as needed
                default:
                    logger.warn(`${logPrefix} Unknown creator category definition type: "${def.type}" for "${def.title}". Skipping.`);
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
                // Modify title if needed, e.g., prepend creator's name or keep as defined.
                // For now, using the title from the definition.
                // let categoryTitle = def.title;
                // if (userProfileData && userProfileData.username) {
                //     categoryTitle = `${userProfileData.username}'s ${def.title}`;
                // }
                
                recipeCategories.push({
                    id: def.id, // Use definition ID
                    title: def.title, // Use title from definition
                    recipes: recipes,
                    canLoadMore: recipes.length === fetchLimit, 
                });
            } else {
                logger.info(`${logPrefix} No recipes found for category "${def.title}" by user ${profileOwnerId}.`);
            }
        }
        
        // Fallback: If no dynamic categories were populated and user has recipes, add an "All Public Recipes"
        // This part is optional, depending on desired behavior if no definitions match.
        if (recipeCategories.length === 0) {
            logger.info(`${logPrefix} No dynamic categories populated. Checking for general public recipes for ${profileOwnerId}.`);
            const allPublicQuery = db.collection("public_recipes")
                .where("isPublic", "==", true)
                .where("createdByUserId", "==", profileOwnerId)
                .orderBy("createdAt", "desc")
                .limit(DEFAULT_ITEMS_PER_CREATOR_CATEGORY); // Or a different limit for this fallback

            const allPublicSnapshot = await allPublicQuery.get();
            const publicRecipes = [];
            allPublicSnapshot.forEach(doc => {
                const summary = formatRecipeSummary(doc.data(), doc.id);
                if (summary) publicRecipes.push(summary);
            });

            if (publicRecipes.length > 0) {
                const creatorUsername = userProfileData ? userProfileData.username : "This Chef";
                recipeCategories.push({
                    id: `creator_all_public_${profileOwnerId}`, // A generic ID for this fallback category
                    title: `All Public Recipes by ${creatorUsername}`,
                    recipes: publicRecipes,
                    canLoadMore: publicRecipes.length === DEFAULT_ITEMS_PER_CREATOR_CATEGORY,
                });
            }
        }

        // --- 4. Return Combined Data ---
        const response = {
            profileInfo: userProfileData, // This will be null if profile not found, client should handle
            recipeCategories: recipeCategories,
        };

        logger.info(`${logPrefix} Successfully fetched data for ${profileOwnerId}. Profile found: ${!!userProfileData}, Categories: ${recipeCategories.length}`); // Changed to logger
        return response;

    } catch (error) {
        logger.error(`${logPrefix} Error for ${profileOwnerId}:`, error); // Changed to logger
        const errorMessage = error.message || "An unknown error occurred while fetching creator profile.";
        throw new HttpsError("internal", errorMessage, error.details); // Pass details if available
    }
});

/**
 * Calculates the total number of saves across all public recipes for a given user.
 */
const getUserTotalSaves = onCall(async (request) => {
    // Optional auth check, but function logic relies on profileOwnerId from data
    // if (!request.auth) {
    //     console.error("getUserTotalSaves: Authentication recommended for context, but not strictly required if profileOwnerId is provided.");
    //     // Depending on strictness, could throw error:
    //     // throw new HttpsError("unauthenticated", "The function should ideally be called while authenticated.");
    // }

    const profileOwnerId = request.data.userId; // Expecting 'userId' from the client
    const logPrefix = "getUserTotalSaves:"; // Standardized prefix

    if (!profileOwnerId || typeof profileOwnerId !== "string" || profileOwnerId.length === 0) {
        logger.error(`${logPrefix} Missing or invalid 'userId' in request data.`, { profileOwnerId }); // Changed to logger
        throw new HttpsError(
            "invalid-argument",
            "The function must be called with a valid 'userId' string in the data payload."
        );
    }

    logger.info(`${logPrefix} Function started for profileOwnerId: ${profileOwnerId}.`); // Changed to logger

    let totalSaves = 0;

    try {
        const publicRecipesRef = db.collection("public_recipes");
        const userPublicRecipesQuery = publicRecipesRef
            .where("createdByUserId", "==", profileOwnerId)
            .where("isPublic", "==", true); // Ensure we only count public recipes

        const publicRecipesSnapshot = await userPublicRecipesQuery.get();

        if (publicRecipesSnapshot.empty) {
            logger.info(`${logPrefix} User ${profileOwnerId} has no public recipes. Total saves is 0.`); // Changed to logger
            return { totalSaves: 0 };
        }

        publicRecipesSnapshot.forEach((recipeDoc) => {
            const recipeData = recipeDoc.data();
            if (typeof recipeData.saveCount === "number" && recipeData.saveCount > 0) {
                totalSaves += recipeData.saveCount;
            }
        });

        logger.info(`${logPrefix} Calculation complete for ${profileOwnerId}. Total saves: ${totalSaves}`); // Changed to logger
        return { totalSaves: totalSaves }; // Ensure this matches client expectation

    } catch (error) {
        logger.error(`${logPrefix} Error during calculation for ${profileOwnerId}:`, error); // Changed to logger
        throw new HttpsError("internal", "Failed to calculate total saves.", error.message);
    }
});

module.exports = {
    getUserAveragePublicRating,
    getCreatorProfileData,
    getUserTotalSaves,
}; 