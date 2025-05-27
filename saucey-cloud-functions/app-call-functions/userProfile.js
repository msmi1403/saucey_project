const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const functions = require("firebase-functions"); // Added for logger
const { logger } = functions; // Added for logger

// Assuming admin is initialized (e.g., in root index.js)
const db = admin.firestore();

// --- Import shared utility functions ---
const { formatRecipeSummary } = require('../utils/recipeFormatters'); // Adjusted path

// --- Constants for profile data fetching ---
const CREATOR_PROFILE_FEATURED_LIMIT = 10; // Max featured on profile
const CREATOR_PROFILE_ALL_PUBLIC_LIMIT = 20;

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
 * Fetches data for a creator's profile page, including their profile info
 * and categorized public recipes.
 * Can be called unauthenticated.
 */
const getCreatorProfileData = onCall(async (request) => {
    const profileOwnerId = request.data.profileOwnerId;
    const callerUid = request.auth ? request.auth.uid : null; // Can be called unauthenticated
    const logPrefix = "getCreatorProfileData:"; // Standardized prefix

    if (!profileOwnerId || typeof profileOwnerId !== "string") {
        logger.error(`${logPrefix} Missing or invalid 'profileOwnerId'.`, { profileOwnerId }); // Changed to logger
        throw new HttpsError("invalid-argument", "Valid 'profileOwnerId' is required.");
    }

    logger.info(`${logPrefix} Function started for profileOwnerId: ${profileOwnerId}, called by: ${callerUid || 'Anon'}.`); // Changed to logger

    try {
        // --- 1. Fetch User Profile Info ---
        const userProfileRef = db.collection("users").doc(profileOwnerId);
        const userProfileSnap = await userProfileRef.get();

        let userProfileData = null;
        if (userProfileSnap.exists) {
            userProfileData = userProfileSnap.data();
            userProfileData.userId = userProfileSnap.id; // Ensure userId is part of the profile data
            userProfileData.username = userProfileData.username || "User"; // Default username if missing
            // Add any other transformations or default values needed by the client
        } else {
            logger.info(`${logPrefix} User profile not found for ${profileOwnerId}.`); // Changed to logger
        }

        // --- 2. Fetch Public Recipes by this Creator ---
        const publicRecipesRef = db.collection("public_recipes");
        const creatorRecipesQuery = publicRecipesRef
            .where("createdByUserId", "==", profileOwnerId)
            .where("isPublic", "==", true)
            .orderBy("createdAt", "desc") 
            .limit(CREATOR_PROFILE_ALL_PUBLIC_LIMIT);

        const creatorRecipesSnapshot = await creatorRecipesQuery.get();
        const publicRecipes = [];
        creatorRecipesSnapshot.forEach((doc) => {
            const summary = formatRecipeSummary(doc.data(), doc.id);
            if (summary) {
                publicRecipes.push(summary);
            }
        });

        // --- 3. Construct Recipe Categories ---
        const recipeCategories = [];
        if (publicRecipes.length > 0) {
            const featuredRecipes = publicRecipes.slice(0, CREATOR_PROFILE_FEATURED_LIMIT);
            if (featuredRecipes.length > 0) {
                recipeCategories.push({
                    title: "Featured Recipes",
                    recipes: featuredRecipes,
                    // type: "featured" // Example if client needs a type identifier
                });
            }

            const creatorUsername = userProfileData ? userProfileData.username : "this chef";
            recipeCategories.push({
                title: `All Public Recipes by ${creatorUsername}`,
                recipes: publicRecipes, 
                // type: "all_public_by_creator"
            });
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