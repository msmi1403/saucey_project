const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin"); // Required for Firestore

// Ensure Firebase Admin is initialized (idempotent)
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const firestore = admin.firestore();

/**
 * [v2] Updates or creates meal plan preferences for the authenticated user in Firestore.
 */
const updateMealPlanPreferences_v2 = onCall(
    { 
        secrets: [
            "TYPESENSE_HOST", 
            "TYPESENSE_SEARCH_API_KEY", 
            "TYPESENSE_ADMIN_API_KEY", 
            "saucey-gemini-key", 
            "saucey-feedback-email-app-password"
        ] 
    },
    async (request) => {
        logger.info("updateMealPlanPreferences_v2 (Gen 2): Function called.", { structuredData: true });

        if (!request.auth) {
            logger.warn("updateMealPlanPreferences_v2 (Gen 2): Unauthenticated access attempt.");
            throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
        }
        const userId = request.auth.uid;
        logger.info(`updateMealPlanPreferences_v2 (Gen 2): Authenticated user: ${userId}`);

        const preferences = request.data;
        if (!preferences) {
            logger.warn("updateMealPlanPreferences_v2 (Gen 2): No preferences data received.", { userId });
            throw new HttpsError("invalid-argument", "No preferences data was provided in the request.");
        }
        logger.info("updateMealPlanPreferences_v2 (Gen 2): Received preferences payload for saving:", { userId, preferences });

        // Enforce server-side defaults and remove disallowed fields
        const preferencesToSave = {
            ...preferences,
            planDurationWeeks: 12, // Enforce 12 weeks
            updatedAtServerTimestamp: admin.firestore.FieldValue.serverTimestamp()
        };

        // Remove targetEventDate if it exists, as it's deprecated
        if (preferencesToSave.hasOwnProperty('targetEventDate')) {
            delete preferencesToSave.targetEventDate;
        }
        if (preferencesToSave.hasOwnProperty('targetEventDateISO')) {
            delete preferencesToSave.targetEventDateISO;
        }

        // TODO: Add detailed server-side validation of the 'preferences' object structure and types here.
        // Example: if (typeof preferences.planDurationWeeks !== 'number' || preferences.planDurationWeeks <= 0) {
        // throw new HttpsError("invalid-argument", "Invalid planDurationWeeks.");
        // }

        try {
            const userPrefsRef = firestore.collection("users").doc(userId).collection("mealPlanPreferences").doc("userPreferences");
            
            await userPrefsRef.set(preferencesToSave, { merge: true });
            logger.info("updateMealPlanPreferences_v2 (Gen 2): Successfully saved preferences to Firestore.", { userId, savedData: preferencesToSave });

            return {
                success: true,
                message: "Meal plan preferences successfully saved to Firestore.",
            };
        } catch (error) {
            logger.error("updateMealPlanPreferences_v2 (Gen 2): Error saving preferences to Firestore.", {
                userId,
                errorMessage: error.message,
                errorStack: error.stack,
                preferencesReceived: preferences
            });
            throw new HttpsError("internal", "An unexpected error occurred while saving your preferences.");
        }
    }
);

module.exports = { updateMealPlanPreferences_v2 }; 