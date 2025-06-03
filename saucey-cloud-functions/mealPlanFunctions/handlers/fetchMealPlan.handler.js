const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * @fileoverview Handler for the fetchMealPlan Firebase Callable Function.
 * @see /saucey-cloud-functions/mealPlanFunctions/types.js for MealPlanDocument type definition
 */

/**
 * Fetches a specific meal plan for the authenticated user.
 * @param {object} data - The data sent by the client.
 * @param {string} data.planId - The ID of the meal plan to fetch.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{plan: MealPlanDocument | null}>} The meal plan document or null if not found.
 * @throws {HttpsError} Throws HttpsError for auth, validation, or internal errors.
 */
const fetchMealPlan = functions.onCall(async (request) => {
  logger.info("fetchMealPlan: Called from handler", { data: request.data });

  if (!request.auth) {
    logger.warn("fetchMealPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;
  const { planId } = request.data;

  if (!planId || typeof planId !== 'string') {
    logger.warn("fetchMealPlan: Invalid or missing planId.", { userId, planId });
    throw new HttpsError("invalid-argument", "A valid 'planId' must be provided.");
  }

  try {
    const collectionPath = `users/${userId}/mealPlans`;
    const mealPlanData = await firestoreHelper.getDocument(collectionPath, planId);

    if (!mealPlanData) {
      logger.info("fetchMealPlan: Plan not found in handler.", { userId, planId });
      return { plan: null };
    }

    logger.info("fetchMealPlan: Plan fetched successfully from handler.", { userId, planId });
    return { plan: mealPlanData }; 

  } catch (error) {
    logger.error("fetchMealPlan: Error fetching plan from Firestore in handler.", {
      userId,
      planId,
      errorMessage: error.message,
      errorStack: error.stack,
    });
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "An unexpected error occurred while fetching the meal plan (handler).", { originalError: error.message });
  }
});

module.exports = { fetchMealPlan }; 