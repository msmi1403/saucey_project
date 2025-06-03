const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors")({ origin: true }); // Configure CORS as needed
const { logger } = require("firebase-functions/v2"); // Use Gen 2 logger

// Admin SDK initialized in root index.js
const db = admin.firestore();

/**
 * HTTP Requestable Function: getRecipeById
 * Fetches a public recipe document from Firestore by its ID.
 * Expects a 'recipeId' query parameter.
 */
const getRecipeById = onRequest(async (req, res) => {
  cors(req, res, async () => {
    const logPrefix = "getRecipeById:";

    if (req.method !== "GET") {
      logger.warn(`${logPrefix} Method Not Allowed: ${req.method}`);
      return res.status(405).send("Method Not Allowed");
    }

    const recipeId = req.query.recipeId;
    if (!recipeId) {
      logger.error(`${logPrefix} Missing 'recipeId' query parameter.`);
      return res.status(400).send("Bad Request: Missing 'recipeId' query parameter.");
    }
    logger.info(`${logPrefix} Received request for recipeId: ${recipeId}`);

    try {
      const recipeRef = db.collection("public_recipes").doc(recipeId);
      const docSnap = await recipeRef.get();

      if (!docSnap.exists) {
        logger.warn(`${logPrefix} Public recipe document with ID ${recipeId} not found.`);
        return res.status(404).send(`Not Found: Public recipe with ID ${recipeId} not found.`);
      }

      const recipeData = docSnap.data();
      // Ensure we only return data appropriate for a public, non-editable recipe view.
      // This should align with what formatRecipeSummary or similar utilities provide for public listings.
      const responseData = {
        recipeId: docSnap.id,
        title: recipeData.title || "No Title",
        imageURL: recipeData.imageURL || null,
        total_time: recipeData.total_time || null,
        servings: recipeData.servings || null,
        // Depending on client needs, you might include more fields like cuisine, averageRating, etc.
        // For now, keeping it concise. If full details are needed, expand this.
        // ingredients: Array.isArray(recipeData.ingredients) ? recipeData.ingredients : [],
        // instructions: Array.isArray(recipeData.instructions) ? recipeData.instructions : [],
        // createdByUsername: recipeData.createdByUsername || null, 
        // averageRating: recipeData.averageRating || 0,
        // saveCount: recipeData.saveCount || 0,
      };
      
      // If detailed recipe data is expected (like ingredients/instructions), add them.
      // Example: if (recipeData.ingredients) responseData.ingredients = recipeData.ingredients;
      // Example: if (recipeData.instructions) responseData.instructions = recipeData.instructions;


      logger.info(`${logPrefix} Successfully fetched public recipe ${recipeId}.`);
      return res.status(200).json(responseData);
    } catch (error) {
      logger.error(`${logPrefix} Error fetching public recipe ${recipeId}:`, error);
      return res.status(500).send("Internal Server Error");
    }
  });
});

module.exports = {
  getRecipeById,
}; 