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

    // Create a mutable copy to avoid modifying the cached version if firestoreHelper returns one
    const mutablePlanData = { ...mealPlanData };

    // Convert Firestore Timestamps to ISO strings if they exist
    if (mutablePlanData.createdAt && typeof mutablePlanData.createdAt.toDate === 'function') {
      mutablePlanData.createdAt = mutablePlanData.createdAt.toDate().toISOString();
      logger.info("fetchMealPlan: Converted 'createdAt' to ISO string.", { userId, planId });
    }
    if (mutablePlanData.updatedAt && typeof mutablePlanData.updatedAt.toDate === 'function') {
      mutablePlanData.updatedAt = mutablePlanData.updatedAt.toDate().toISOString();
      logger.info("fetchMealPlan: Converted 'updatedAt' to ISO string.", { userId, planId });
    }
    // Also check startDate and endDate, just in case they were ever stored as Timestamps, though model expects string.
    // This is more for robustness if data sources were inconsistent.
    if (mutablePlanData.startDate && typeof mutablePlanData.startDate.toDate === 'function') {
      mutablePlanData.startDate = mutablePlanData.startDate.toDate().toISOString();
       logger.info("fetchMealPlan: Converted 'startDate' to ISO string (was unexpectedly a Timestamp).", { userId, planId });
    }
    if (mutablePlanData.endDate && typeof mutablePlanData.endDate.toDate === 'function') {
      mutablePlanData.endDate = mutablePlanData.endDate.toDate().toISOString();
      logger.info("fetchMealPlan: Converted 'endDate' to ISO string (was unexpectedly a Timestamp).", { userId, planId });
    }

    logger.info("fetchMealPlan: Plan fetched and timestamps converted successfully from handler.", { userId, planId });
    return { plan: mutablePlanData }; 

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