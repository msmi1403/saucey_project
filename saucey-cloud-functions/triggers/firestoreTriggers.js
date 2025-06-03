const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2"); // Corrected: Use Gen 2 logger
const Typesense = require("typesense"); // Required for Typesense.Client

// Admin SDK should be initialized in root index.js
const db = admin.firestore();

// --- Import from Typesense Service --- 
const {
    getTypesenseAdminClient, // We need the admin client for upserting/deleting
    RECIPES_COLLECTION_NAME,
    ensureTypesenseCollectionExists,
    // getSecretValue is NOT directly needed here if getTypesenseAdminClient handles init
    // typesenseInitializationPromise // Ensure client is ready before operations
} = require('../services/typesenseService');

/**
 * Firestore Trigger: onDocumentWritten (public_recipes/{recipeId}/reviews/{reviewId})
 * Updates the average rating and review count on a public recipe when a review is added, updated, or deleted.
 * Note: The original function used {userId} as the review document ID. Changed to {reviewId} for clarity,
 * assuming the review document ID might not always be the userId, or for better generality.
 * If the review document ID is indeed always the userId, this can be reverted.
 */
const updatePublicRecipeRating = onDocumentWritten(
  "public_recipes/{recipeId}/reviews/{reviewId}", // Path based on original
  async (event) => {
    const recipeId = event.params.recipeId;
    const reviewId = event.params.reviewId; // Useful for logging
    const logPrefix = `updatePublicRecipeRating[Recipe:${recipeId}, Review:${reviewId}]:`;

    logger.info(`${logPrefix} Triggered by write to review document.`);

    const recipeRef = db.collection("public_recipes").doc(recipeId);
    const reviewsRef = recipeRef.collection("reviews");

    try {
      const reviewsSnapshot = await reviewsRef.get();

      let totalRatingSum = 0;
      let reviewCount = 0;

      if (reviewsSnapshot.empty) {
        logger.info(`${logPrefix} No reviews found for recipe. Resetting rating stats.`);
        await recipeRef.update({
          averageRating: admin.firestore.FieldValue.delete(), // Remove field if no reviews
          reviewCount: 0,
        });
        logger.info(`${logPrefix} Successfully reset rating stats for recipe.`);
        return null;
      }

      reviewsSnapshot.forEach((doc) => {
        const reviewData = doc.data();
        if (typeof reviewData.rating === "number" && !isNaN(reviewData.rating)) {
          totalRatingSum += reviewData.rating;
          reviewCount++;
        } else {
          logger.warn(
            `${logPrefix} Review document ${doc.id} has invalid or missing 'rating'.`, 
            { rating: reviewData.rating }
          );
        }
      });

      const averageRating = reviewCount > 0 ? totalRatingSum / reviewCount : 0;
      const finalAverageRating = parseFloat(averageRating.toFixed(1));

      logger.info(
        `${logPrefix} Calculated: ${reviewCount} reviews, ` +
        `TotalSum: ${totalRatingSum}, AvgRating: ${finalAverageRating}`
      );

      await recipeRef.update({
        averageRating: finalAverageRating, // Store as number rounded to 1 decimal
        reviewCount: reviewCount,
      });

      logger.info(`${logPrefix} Successfully updated average rating and review count for recipe.`);
      return null;
    } catch (error) {
      logger.error(`${logPrefix} Error updating public recipe rating:`, error);
      // Re-throwing the error might be better for v2 functions to signal failure explicitly.
      // However, original function returned null, so keeping that behavior for now.
      return null;
    }
  }
);

/**
 * Firestore Trigger: onDocumentWritten (users/{userId}/chapters/{chapterId}/recipes/{recipeId})
 * Handles recipe save/unsave events by a user.
 * - Updates the master `saveCount` on the corresponding `public_recipes` document.
 * - Adds/removes a record in the `recipeSaves` collection to log the event.
 */
const handleRecipeSave = onDocumentWritten(
  "users/{userId}/chapters/{chapterId}/recipes/{recipeId}",
  async (event) => {
    const recipeId = event.params.recipeId;
    const savingUserId = event.params.userId;
    const chapterId = event.params.chapterId; // Available if needed for more specific logging
    const logPrefix = `handleRecipeSave[User:${savingUserId}, Recipe:${recipeId}, Chapter:${chapterId}]:`;

    const isSave = event.data.after.exists && !event.data.before.exists;
    const isUnsave = !event.data.after.exists && event.data.before.exists;

    if (!isSave && !isUnsave) {
      logger.info(`${logPrefix} Ignoring event (not a create or delete).`);
      return null; 
    }

    logger.info(`${logPrefix} Processing ${isSave ? 'SAVE' : 'UNSAVE'} event.`);

    const publicRecipeRef = db.collection("public_recipes").doc(recipeId);
    const recipeSavesCollection = db.collection("recipeSaves");

    try {
      const publicDocSnap = await publicRecipeRef.get();
      if (!publicDocSnap.exists) {
        logger.warn(`${logPrefix} Public recipe document not found. Cannot update save counts or logs.`);
        return null;
      }

      const incrementValue = isSave ? 1 : -1;
      await publicRecipeRef.update({
        saveCount: admin.firestore.FieldValue.increment(incrementValue),
      });
      logger.info(`${logPrefix} Updated saveCount on public recipe by ${incrementValue}.`);

      if (isSave) {
        await recipeSavesCollection.add({
          recipeId: recipeId,
          userId: savingUserId,
          savedAt: admin.firestore.FieldValue.serverTimestamp(),
          action: "save", // Explicitly log the action type
        });
        logger.info(`${logPrefix} Added entry to recipeSaves collection.`);
      } else if (isUnsave) {
        const saveQuery = recipeSavesCollection
          .where("recipeId", "==", recipeId)
          .where("userId", "==", savingUserId)
          // .where("action", "==", "save") // Could make query more specific if needed
          .orderBy("savedAt", "desc") // Get the most recent save entry if multiple existed (though original logic takes 1)
          .limit(1);

        const saveSnapshot = await saveQuery.get();
        if (!saveSnapshot.empty) {
          const docToDelete = saveSnapshot.docs[0];
          await docToDelete.ref.delete();
          logger.info(`${logPrefix} Removed entry ${docToDelete.id} from recipeSaves collection.`);
        } else {
          logger.warn(`${logPrefix} No matching save entry found in recipeSaves to remove.`);
        }
      }
      return null;
    } catch (error) {
      logger.error(`${logPrefix} Error handling recipe save/unsave:`, error);
      return null; 
    }
  }
);

/**
 * Firestore Trigger: onDocumentWritten (public_recipes/{recipeId})
 * Syncs changes to public recipe documents (create, update, delete) to Typesense.
 */
const syncRecipeToTypesense = onDocumentWritten(
  "public_recipes/{recipeId}",
  async (event) => {
    const recipeId = event.params.recipeId;
    const logPrefix = `syncRecipeToTypesense[Recipe:${recipeId}]:`;

    // Get the Admin Client from the service. It handles its own initialization.
    // The typesenseInitializationPromise in the service ensures it's ready.
    // However, the original function initialized a *new* client each time.
    // For a trigger, a shared admin client is generally fine if rate limits aren't an issue.
    // Sticking to shared client pattern established by typesenseService.js
    const typesenseAdminClient = getTypesenseAdminClient(); 

    if (!typesenseAdminClient) {
      logger.error(`${logPrefix} Typesense Admin client not available. Aborting sync.`);
      // This indicates a serious problem with Typesense initialization.
      // Depending on policy, could throw error to force retry or log and exit.
      return null; 
    }

    try {
      // Ensure the collection exists. This also relies on the admin client.
      // This might be slightly redundant if the admin client init itself ensures this,
      // but explicit check is safer and matches original logic.
      await ensureTypesenseCollectionExists(typesenseAdminClient);

      const typesenseCollection = typesenseAdminClient.collections(RECIPES_COLLECTION_NAME);

      // Deletion
      if (!event.data.after.exists) {
        logger.info(`${logPrefix} Document deleted in Firestore. Deleting from Typesense.`);
        try {
          await typesenseCollection.documents(recipeId).delete();
          logger.info(`${logPrefix} Successfully deleted document from Typesense.`);
        } catch (error) {
          // Log a warning if deletion fails (e.g., doc already gone from Typesense)
          // but don't let it crash the function, as Firestore delete already happened.
          logger.warn(`${logPrefix} Warning during Typesense deletion (may already be deleted):`, error.message);
        }
        return null;
      }

      // Create or Update
      logger.info(`${logPrefix} Document created/updated in Firestore. Upserting to Typesense.`);
      const recipeData = event.data.after.data();
      
      const typesenseDoc = {
        id: recipeId, // Crucial for Typesense to identify the document
        recipeId: recipeId, // Keep for consistency if client apps expect it
        title: recipeData.title || "", // Default to empty string if null/undefined
        createdByUsername: recipeData.createdByUsername || null,
        imageURL: recipeData.imageURL || null,
        cuisine: recipeData.cuisine || null,
        tags: Array.isArray(recipeData.tags) ? recipeData.tags : [],
        saveCount: typeof recipeData.saveCount === 'number' ? recipeData.saveCount : 0,
        averageRating: typeof recipeData.averageRating === 'number' ? recipeData.averageRating : null,
        reviewCount: typeof recipeData.reviewCount === 'number' ? recipeData.reviewCount : 0,
        // Convert Firestore Timestamp to Unix epoch seconds for Typesense (if field exists)
        createdAt: recipeData.createdAt && recipeData.createdAt.seconds ? recipeData.createdAt.seconds : null,
        isPublic: typeof recipeData.isPublic === 'boolean' ? recipeData.isPublic : false,
        difficulty: recipeData.difficulty || null,
        category: recipeData.category || null,
        total_time: recipeData.total_time || null,
        // Add any other fields from your recipeSchema that need to be indexed/retrievable
      };

      // Remove null/undefined fields before upserting to keep documents clean
      // (Typesense handles optional fields, but explicit nulls can be avoided)
      Object.keys(typesenseDoc).forEach((key) => {
        if (typesenseDoc[key] === null || typesenseDoc[key] === undefined) {
          // For Typesense, it's often better to omit the field entirely 
          // if it's truly optional and null, rather than sending `null`.
          // However, if your schema defines `optional: true` and you want to explicitly clear a value,
          // sending `null` might be intended. For now, we'll remove them.
          delete typesenseDoc[key];
        }
      });

      await typesenseCollection.documents().upsert(typesenseDoc);
      logger.info(`${logPrefix} Successfully upserted document to Typesense.`);

    } catch (error) {
      logger.error(`${logPrefix} Error during Typesense sync:`, error);
      // Depending on policy, could throw to signal failure and retry, or just log.
      // Original function returned null.
      return null; 
    }
    return null;
  }
);

module.exports = {
  updatePublicRecipeRating,
  handleRecipeSave,
  syncRecipeToTypesense,
}; 