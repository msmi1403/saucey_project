const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
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
 * Unpublishes a public recipe by setting its isPublic flag to false.
 * Requires authentication and ownership of the recipe.
 */
const unpublishPublicRecipe = onCall(async (request) => {
  // 1. Check authentication using request.auth
  if (!request.auth) {
    console.error("unpublishPublicRecipe: Authentication required.");
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const recipeId = request.data.recipeId;

  // 2. Validate input
  if (!recipeId || typeof recipeId !== "string" || recipeId.length === 0) {
    console.error("unpublishPublicRecipe: Invalid recipeId provided.", { recipeId });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with a valid 'recipeId' string."
    );
  }

  const publicRecipeRef = db.collection("public_recipes").doc(recipeId);

  try {
    const publicRecipeDoc = await publicRecipeRef.get();

    // 3. Check if the public recipe document exists
    if (!publicRecipeDoc.exists) {
      console.log(
        `unpublishPublicRecipe: Recipe ${recipeId} not found in public_recipes. No action needed.`
      );
      return {
        success: true,
        message: "Recipe not found in public collection.",
      };
    }

    const recipeData = publicRecipeDoc.data();

    // 4. Verify ownership (Security Check)
    if (!recipeData.createdByUserId) {
      console.error(
        `unpublishPublicRecipe: Missing createdByUserId field on public recipe ${recipeId}. Cannot verify owner.`
      );
      throw new HttpsError(
        "failed-precondition",
        "Recipe is missing creator information."
      );
    }

    if (recipeData.createdByUserId !== userId) {
      console.error(
        `unpublishPublicRecipe: User ${userId} attempted to unpublish recipe ${recipeId} owned by ${recipeData.createdByUserId}.`
      );
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to unpublish this recipe."
      );
    }

    // 5. Perform the unpublish action (Set isPublic to false)
    await publicRecipeRef.update({ isPublic: false });
    console.log(
      `unpublishPublicRecipe: Successfully set isPublic=false for recipe ${recipeId} in public_recipes by owner ${userId}.`
    );
    return { success: true, message: "Recipe marked as not public." };
  } catch (error) {
    console.error(
      `unpublishPublicRecipe: Error unpublishing recipe ${recipeId} from public_recipes:`,
      error
    );
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError(
      "internal",
      "An error occurred while unpublishing the recipe.",
      error.message // Include original error message for better debugging
    );
  }
});

module.exports = {
    unpublishPublicRecipe,
}; 