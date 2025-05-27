const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

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
    if (!request.auth) {
        console.error("getUserAveragePublicRating: Authentication required.");
        throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    const userId = request.auth.uid; // Recipes CREATED BY this user
    const logPrefix = `getUserAveragePublicRating[User:${userId}]:`;
    console.log(`${logPrefix} Function started.`);

    let totalAverageRatingSum = 0;
    let publicRecipeCountWithRating = 0;

    try {
        const publicRecipesRef = db.collection("public_recipes");
        const userPublicRecipesQuery = publicRecipesRef
            .where("createdByUserId", "==", userId)
            .where("isPublic", "==", true);

        const publicRecipesSnapshot = await userPublicRecipesQuery.get();

        if (publicRecipesSnapshot.empty) {
            console.log(`${logPrefix} User has no public recipes.`);
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

        console.log(`${logPrefix} Calculation complete. Result:`, result);
        return result;
    } catch (error) {
        console.error(`${logPrefix} Error during calculation:`, error);
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

    if (!profileOwnerId || typeof profileOwnerId !== "string") {
        console.error("getCreatorProfileData: Missing or invalid 'profileOwnerId'.", { profileOwnerId });
        throw new HttpsError("invalid-argument", "Valid 'profileOwnerId' is required.");
    }

    const logPrefix = `getCreatorProfileData[Owner:${profileOwnerId}, Caller:${callerUid || 'Anon'}]:`;
    console.log(`${logPrefix} Function started.`);

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
            console.log(`${logPrefix} User profile not found for ${profileOwnerId}.`);
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

        console.log(`${logPrefix} Successfully fetched data. Profile found: ${!!userProfileData}, Categories: ${recipeCategories.length}`);
        return response;

    } catch (error) {
        console.error(`${logPrefix} Error:`, error);
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

    if (!profileOwnerId || typeof profileOwnerId !== "string" || profileOwnerId.length === 0) {
        console.error("getUserTotalSaves: Missing or invalid 'userId' in request data.", { profileOwnerId });
        throw new HttpsError(
            "invalid-argument",
            "The function must be called with a valid 'userId' string in the data payload."
        );
    }

    const logPrefix = `getUserTotalSaves[ProfileOwner:${profileOwnerId}]:`;
    console.log(`${logPrefix} Function started.`);

    let totalSaves = 0;

    try {
        const publicRecipesRef = db.collection("public_recipes");
        const userPublicRecipesQuery = publicRecipesRef
            .where("createdByUserId", "==", profileOwnerId)
            .where("isPublic", "==", true); // Ensure we only count public recipes

        const publicRecipesSnapshot = await userPublicRecipesQuery.get();

        if (publicRecipesSnapshot.empty) {
            console.log(`${logPrefix} User has no public recipes. Total saves is 0.`);
            return { totalSaves: 0 };
        }

        publicRecipesSnapshot.forEach((recipeDoc) => {
            const recipeData = recipeDoc.data();
            if (typeof recipeData.saveCount === "number" && recipeData.saveCount > 0) {
                totalSaves += recipeData.saveCount;
            }
        });

        console.log(`${logPrefix} Calculation complete. Total saves: ${totalSaves}`);
        return { totalSaves: totalSaves }; // Ensure this matches client expectation

    } catch (error) {
        console.error(`${logPrefix} Error during calculation:`, error);
        throw new HttpsError(
            "internal",
            "Failed to calculate user's total recipe saves.",
            error.message
        );
    }
});

module.exports = {
    getUserAveragePublicRating,
    getCreatorProfileData,
    getUserTotalSaves,
}; 