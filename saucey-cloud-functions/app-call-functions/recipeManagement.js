const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2"); // Use Gen 2 logger
// Import the recipe parsing service
const { parseRecipeText } = require('../handleRecipeChatTurn/services/recipeParsingService');
// Assuming admin is initialized in a shared file, e.g., ../shared/firebaseAdmin.js
// If not, you might need:
// admin.initializeApp(); 
// For now, let's assume db is correctly sourced from an initialized admin instance.
// If your main `saucey-cloud-functions/index.js` or a shared setup file initializes admin,
// you can usually just use admin.firestore() directly.
// Let's try to get db from the shared admin instance if it's set up that way,
// otherwise, we might need to adjust how db is accessed.
// For now, assuming a global or appropriately scoped 'db' from admin.firestore().
// const db = admin.firestore(); // This would be typical if admin is initialized here or globally.

// To use the existing shared admin instance from ../shared/firebaseAdmin.js (if it exports 'db')
// const { db } = require('../shared/firebaseAdmin'); // Adjust path if necessary

// Let's assume for now that admin has been initialized in index.js or a shared module
// and admin.firestore() can be called.
// If you have a shared/firebaseAdmin.js that exports db:
// const { db } = require('../shared/admin'); // or similar path
// For this example, we'll define db directly for clarity if admin is globally initialized.
// However, the best practice is to get it from your shared admin initialization.

// Let's get db from the existing admin instance provided by firebase-functions
// This is usually available after admin.initializeApp() has been called in the root index.js
const db = admin.firestore();


/**
 * Unpublishes a public recipe by setting its isPublic flag to false and updating lastUpdated.
 * Requires authentication and ownership of the recipe.
 */
const unpublishPublicRecipe = onCall(async (request) => {
  const logPrefix = "unpublishPublicRecipe:"; // Added for logger

  // 1. Check authentication using request.auth
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`); // Changed to logger
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const recipeId = request.data.recipeId;

  // 2. Validate input
  if (!recipeId || typeof recipeId !== "string" || recipeId.length === 0) {
    logger.error(`${logPrefix} Invalid recipeId provided.`, { recipeId }); // Changed to logger
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with a valid 'recipeId' string."
    );
  }
  logger.info(`${logPrefix} User ${userId} attempting to unpublish recipe ${recipeId}.`); // Added for logger

  const publicRecipeRef = db.collection("public_recipes").doc(recipeId);

  try {
    const publicRecipeDoc = await publicRecipeRef.get();

    // 3. Check if the public recipe document exists
    if (!publicRecipeDoc.exists) {
      logger.info(
        `${logPrefix} Recipe ${recipeId} not found in public_recipes. No action needed.` // Changed to logger
      );
      return {
        success: true,
        message: "Recipe not found in public collection.",
      };
    }

    const recipeData = publicRecipeDoc.data();

    // 4. Verify ownership (Security Check)
    if (!recipeData.createdByUserId) {
      logger.error(
        `${logPrefix} Missing createdByUserId field on public recipe ${recipeId}. Cannot verify owner.` // Changed to logger
      );
      throw new HttpsError(
        "failed-precondition",
        "Recipe is missing creator information."
      );
    }

    if (recipeData.createdByUserId !== userId) {
      logger.error(
        `${logPrefix} User ${userId} attempted to unpublish recipe ${recipeId} owned by ${recipeData.createdByUserId}.` // Changed to logger
      );
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to unpublish this recipe."
      );
    }

    // 5. Perform the unpublish action (Set isPublic to false and update lastUpdated)
    const updateData = {
      isPublic: false,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(), // Added lastUpdated
    };
    await publicRecipeRef.update(updateData);
    logger.info(
      `${logPrefix} Successfully set isPublic=false and updated lastUpdated for recipe ${recipeId} in public_recipes by owner ${userId}.` // Changed to logger
    );
    return { success: true, message: "Recipe unpublished and marked as not public." }; // Updated message
  } catch (error) {
    logger.error(
      `${logPrefix} Error unpublishing recipe ${recipeId} from public_recipes:`, // Changed to logger
      error
    );
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError(
      "internal",
      "An error occurred while unpublishing the recipe.",
      error.message
    );
  }
});

/**
 * Parses conversational recipe text into structured JSON format for saving to cookbook
 */
const parseRecipeForCookbook = onCall(async (request) => {
  const logPrefix = "parseRecipeForCookbook:";

  // 1. Check authentication
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`);
    throw new HttpsError(
      "unauthenticated", 
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const { recipeText } = request.data;

  // 2. Validate input
  if (!recipeText || typeof recipeText !== "string" || recipeText.trim().length === 0) {
    logger.error(`${logPrefix} Invalid recipeText provided.`, { recipeText });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with valid 'recipeText' string."
    );
  }

  if (recipeText.length > 10000) {
    logger.error(`${logPrefix} Recipe text too long: ${recipeText.length} characters.`);
    throw new HttpsError(
      "invalid-argument", 
      "Recipe text is too long. Maximum 10,000 characters allowed."
    );
  }

  logger.info(`${logPrefix} User ${userId} parsing recipe text of ${recipeText.length} characters.`);

  try {
    // 3. Get user preferences for context
    let userPreferences = null;
    try {
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        userPreferences = {
          difficulty: userData.preferredRecipeDifficulty || 'medium',
          allergensToAvoid: userData.allergensToAvoid || [],
          dietaryPreferences: userData.dietaryPreferences || [],
          customDietaryNotes: userData.customDietaryNotes || '',
          preferredCookTimePreference: userData.preferredCookTimePreference || '',
        };
      }
    } catch (prefError) {
      logger.warn(`${logPrefix} Could not fetch user preferences for ${userId}: ${prefError.message}`);
    }

    // 4. Parse the recipe text using the existing service
    const parsedRecipe = await parseRecipeText(recipeText, userPreferences);

    // 5. Add metadata for cookbook saving
    parsedRecipe.createdByUserId = userId;
    parsedRecipe.createdAt = admin.firestore.FieldValue.serverTimestamp();
    parsedRecipe.source = 'generated_chat_saved';
    parsedRecipe.isPublic = false;
    parsedRecipe.isSecretRecipe = false;

    logger.info(`${logPrefix} Successfully parsed recipe: ${parsedRecipe.title} for user ${userId}`);

    return {
      success: true,
      recipe: parsedRecipe,
      message: "Recipe parsed successfully"
    };

  } catch (error) {
    logger.error(`${logPrefix} Error parsing recipe text for user ${userId}:`, {
      error: error.message,
      stack: error.stack,
      recipeTextLength: recipeText.length
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      "Failed to parse recipe. Please try again or check if the text contains a complete recipe.",
      error.message
    );
  }
});

module.exports = {
    unpublishPublicRecipe,
    parseRecipeForCookbook,
}; 