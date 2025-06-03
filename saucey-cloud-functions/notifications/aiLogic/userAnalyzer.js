// saucey-cloud-functions/notifications/aiLogic/userAnalyzer.js
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const { logger } = require("firebase-functions/v2");

/**
 * Analyzes user activity and preferences to create context for notifications.
 * @param {string} userId The ID of the user.
 * @param {Object} [userData] Optional pre-fetched user data.
 * @returns {Promise<Object|null>} A context object or null if essential data is missing.
 */
async function analyzeUserActivityAndPrefs(userId, userData = null) {
    logger.log(`Analyzing activity for user: ${userId}`);
    try {
        let userDoc = userData;
        if (!userDoc) {
            userDoc = await firestoreHelper.getDocument("users", userId);
        }

        if (!userDoc) {
            logger.warn(`User document not found for userId: ${userId}`);
            return null;
        }

        // Basic context from user profile
        const context = {
            userId: userId,
            displayName: userDoc.displayName || "Foodie",
            preferences: {
                preferredRecipeDifficulty: userDoc.preferredRecipeDifficulty,
                preferredCookTimePreference: userDoc.preferredCookTimePreference,
                selectedDietaryFilters: userDoc.selectedDietaryFilters,
                customDietaryNotes: userDoc.customDietaryNotes,
                preferredChefPersonality: userDoc.preferredChefPersonality || "Helpful Chef",
            },
            activity: {
                // These would be populated by fetching relevant data, e.g., last 5 cooked/viewed recipes
                lastCookedRecipe: null, // Example: { name: "Spaghetti Carbonara", id: "xyz" }
                recentlyViewedRecipes: [], // Example: [{ name: "Chicken Stir-fry", id: "abc" }]
                favoriteCuisine: null, // Could be derived from cooked/saved recipes
            },
            // Add more fields as needed, e.g., engagement metrics
            lastActiveDate: userDoc.lastLoginDate || userDoc.createdAt,
            isProUser: userDoc.isProUser || false,
            proSubscriptionExpiryDate: userDoc.proSubscriptionExpiryDate,
        };

        // --- Placeholder for fetching more detailed activity ---
        // Example: Fetch last cooked recipe from a 'userCookHistory' collection
        // const cookHistory = await firestoreHelper.getCollection(`users/${userId}/cookHistory`, {
        //     orderBy: "cookedDate",
        //     limit: 1,
        //     orderDirection: "desc"
        // });
        // if (cookHistory.length > 0) {
        //     context.activity.lastCookedRecipe = { name: cookHistory[0].recipeName, id: cookHistory[0].recipeId };
        // }

        // --- Placeholder for deriving favorite cuisine ---
        // This would involve more complex logic, perhaps analyzing tags of saved/cooked recipes

        logger.log(`Context for user ${userId}:`, context);
        return context;

    } catch (error) {
        logger.error(`Error analyzing user activity for ${userId}:`, error);
        return null; // Return null or a default minimal context
    }
}

module.exports = {
    analyzeUserActivityAndPrefs,
};