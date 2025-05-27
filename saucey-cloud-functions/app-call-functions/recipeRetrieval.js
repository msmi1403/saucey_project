const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const cors = require("cors")({ origin: true }); // Configure CORS as needed
const functions = require("firebase-functions"); // For logger
const { logger } = functions;

// Admin SDK initialized in root index.js
const db = admin.firestore();

/**
 * HTTP Requestable Function: getRecipeById
 * Fetches a recipe document from Firestore by its ID.
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
      // The original function fetched from a top-level 'recipes' collection.
      // Adjust if your public, shareable recipes are in 'public_recipes' or another collection.
      // For now, assuming 'recipes' is the correct collection for recipes fetchable by ID this way.
      const recipeRef = db.collection("recipes").doc(recipeId);
      const docSnap = await recipeRef.get();

      if (!docSnap.exists) {
        logger.warn(`${logPrefix} Recipe document with ID ${recipeId} not found.`);
        return res.status(404).send(`Not Found: Recipe with ID ${recipeId} not found.`);
      }

      const recipeData = docSnap.data();
      const responseData = {
        recipeId: docSnap.id,
        title: recipeData.title || "No Title",
        total_time: recipeData.total_time || null,
        servings: recipeData.servings || null,
        ingredients: Array.isArray(recipeData.ingredients) ? recipeData.ingredients : [],
        instructions: Array.isArray(recipeData.instructions) ? recipeData.instructions : [],
        // Add other fields as expected by clients calling this specific endpoint
        // For example, if this is for full recipe details:
        // cuisine: recipeData.cuisine || null,
        // difficulty: recipeData.difficulty || null,
        // createdByUserId: recipeData.createdByUserId || null,
        // createdByUsername: recipeData.createdByUsername || null,
        // imageURL: recipeData.imageURL || null,
        // etc.
      };

      logger.info(`${logPrefix} Successfully fetched recipe ${recipeId}.`);
      return res.status(200).json(responseData);
    } catch (error) {
      logger.error(`${logPrefix} Error fetching recipe ${recipeId}:`, error);
      return res.status(500).send("Internal Server Error");
    }
  });
});

module.exports = {
  getRecipeById,
}; 