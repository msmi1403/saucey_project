const functions = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { HttpsError } = require("firebase-functions/v2/https");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * @fileoverview Handler for the saveMealPlan Firebase Callable Function.
 * @see /saucey-cloud-functions/mealPlanFunctions/types.js for MealPlanDocument type definition
 */

/**
 * Saves a user's meal plan to Firestore.
 * @param {object} data - The data sent by the client.
 * @param {MealPlanDocument} data.plan - The meal plan document to save.
 * @param {functions.https.CallableRequest} request - Firebase callable function request context.
 * @returns {Promise<{success: boolean, planId: string}>} Confirmation and planId.
 * @throws {HttpsError} Throws HttpsError for auth, validation, or internal errors.
 */
const saveMealPlan = functions.onCall(async (request) => {
  logger.info("saveMealPlan: Called from handler", { data: request.data });

  if (!request.auth) {
    logger.warn("saveMealPlan: Unauthenticated access attempt.");
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  const userId = request.auth.uid;

  const { plan } = request.data;

  // Basic validation (consider moving to a validation helper if it grows complex)
  if (!plan || typeof plan !== "object") {
    logger.warn("saveMealPlan: Invalid plan data format.", { userId, planData: plan });
    throw new HttpsError("invalid-argument", "Invalid plan data format. Expected an object under 'plan' key.");
  }
  if (!plan.planId || typeof plan.planId !== 'string') {
    logger.warn("saveMealPlan: Missing or invalid planId.", { userId, planId: plan.planId });
    throw new HttpsError("invalid-argument", "Plan must have a valid 'planId'.");
  }
  if (!plan.name || typeof plan.name !== 'string') {
    logger.warn("saveMealPlan: Missing or invalid plan name.", { userId, name: plan.name });
    throw new HttpsError("invalid-argument", "Plan must have a valid 'name'.");
  }
  if (!plan.startDate || !plan.endDate) {
     logger.warn("saveMealPlan: Missing startDate or endDate.", { userId, plan });
     throw new HttpsError("invalid-argument", "Plan must have 'startDate' and 'endDate'.");
  }
  if (!Array.isArray(plan.days) || plan.days.length === 0) {
    logger.warn("saveMealPlan: Plan must have at least one day.", { userId, plan });
    throw new HttpsError("invalid-argument", "Plan must have a 'days' array with at least one day object.");
  }
  // TODO: Add more specific validation for days, meals, items as needed.

  const planToSave = {
    ...plan, 
    userId: userId, 
  };

  try {
    await firestoreHelper.saveDocument(`users/${userId}/mealPlans`, plan.planId, planToSave, { merge: true });

    logger.info("saveMealPlan: Plan saved successfully from handler.", { userId, planId: plan.planId });
    return { success: true, planId: plan.planId };

  } catch (error) {
    logger.error("saveMealPlan: Error saving plan to Firestore from handler.", {
      userId,
      planId: plan.planId,
      errorMessage: error.message,
      errorStack: error.stack,
    });
    throw new HttpsError("internal", "An unexpected error occurred while saving the meal plan (handler).", { originalError: error.message });
  }
});

module.exports = { saveMealPlan }; 