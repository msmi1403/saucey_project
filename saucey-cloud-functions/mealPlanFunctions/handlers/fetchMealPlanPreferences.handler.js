const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin"); // Import firebase-admin

// Ensure Firebase Admin is initialized (idempotent)
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const firestore = admin.firestore(); // Initialize Firestore

/**
 * @fileoverview Handler for the fetchMealPlanPreferences Firebase Callable Function.
 * @see /saucey-cloud-functions/mealPlanFunctions/types.js for type definitions
 */

/**
 * Fetches the user's meal plan preferences.
 * @param {object} data - The data sent by the client (can be empty).
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success?: boolean, mealPlanPreferences: object | null, message?: string}>} User's meal plan preferences or null.
 * @throws {HttpsError} Throws HttpsError for authentication or internal errors.
 */
const fetchMealPlanPreferences = functions.onCall(async (request) => {
  logger.info("fetchMealPlanPreferences: Called from handler"); // Renamed log for clarity

  if (!request.auth) {
    logger.warn("fetchMealPlanPreferences: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;
  logger.info('fetchMealPlanPreferences: Authenticated user: ' + userId);

  try {
    const userPrefsRef = firestore.collection("users").doc(userId).collection("mealPlanPreferences").doc("userPreferences");
    const docSnap = await userPrefsRef.get();

    if (docSnap.exists) {
      let preferencesData = docSnap.data();
      logger.info("fetchMealPlanPreferences: Successfully fetched preferences from Firestore.", { userId, preferencesData });
      
      // Remove server timestamp before sending to client if it exists
      if (preferencesData && preferencesData.hasOwnProperty('updatedAtServerTimestamp')) {
        delete preferencesData.updatedAtServerTimestamp;
      }

      return { mealPlanPreferences: preferencesData }; // Return fetched data
    } else {
      logger.info("fetchMealPlanPreferences: No preferences document found for user. Returning null.", { userId });
      // Return null or a default structure if no preferences are found
      // The client-side MealPlanService handles `nil` by creating MealPlanPreferences.default
      return { mealPlanPreferences: null }; 
    }

  } catch (error) {
    logger.error("fetchMealPlanPreferences: Error encountered in handler.", {
      userId,
      errorMessage: error.message,
      stack: error.stack, 
    });
    throw new HttpsError("internal", "An unexpected error occurred in fetchMealPlanPreferences.");
  }
});

module.exports = { fetchMealPlanPreferences }; 