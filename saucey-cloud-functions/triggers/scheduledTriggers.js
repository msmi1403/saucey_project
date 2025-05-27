const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const functions = require("firebase-functions"); // For logger
const { logger } = functions;

// Admin SDK should be initialized in root index.js
const db = admin.firestore();

/**
 * Scheduled Trigger: Runs every 6 hours.
 * Updates the `recentSaveCount` for all public recipes.
 * `recentSaveCount` is the number of times a recipe has been saved in the last 7 days.
 */
const updateAllRecentSaveCounts = onSchedule("every 6 hours", async (event) => {
  const logPrefix = "updateAllRecentSaveCounts:";
  logger.info(`${logPrefix} Scheduled function started. Event ID: ${event.id}`);

  const publicRecipesRef = db.collection("public_recipes");
  const recipeSavesRef = db.collection("recipeSaves");
  const batchSize = 200; // Process recipes in batches for Firestore operations
  let lastDoc = null;
  let recipesProcessedCount = 0;
  let totalUpdatesCommitted = 0;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sevenDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(sevenDaysAgo);
  logger.info(`${logPrefix} Calculating recent saves since: ${sevenDaysAgo.toISOString()}`);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = publicRecipesRef
        .orderBy(admin.firestore.FieldPath.documentId()) // Paginate by document ID
        .limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const publicRecipesSnapshot = await query.get();
      if (publicRecipesSnapshot.empty) {
        logger.info(`${logPrefix} No more public recipes to process.`);
        break;
      }

      logger.info(`${logPrefix} Processing batch of ${publicRecipesSnapshot.size} public recipes.`);
      
      let writeBatch = db.batch();
      let writesInCurrentBatch = 0;
      const commitPromises = [];

      for (const recipeDoc of publicRecipesSnapshot.docs) {
        const recipeId = recipeDoc.id;
        const currentData = recipeDoc.data();

        const recentSavesQuery = recipeSavesRef
          .where("recipeId", "==", recipeId)
          .where("savedAt", ">=", sevenDaysAgoTimestamp);
        
        // Using .count() is efficient for getting aggregates
        const recentSavesCountSnapshot = await recentSavesQuery.count().get();
        const newRecentSaveCount = recentSavesCountSnapshot.data().count;

        if (currentData.recentSaveCount !== newRecentSaveCount) {
          logger.info(
            `${logPrefix} Updating recentSaveCount for recipe ${recipeId} ` +
            `from ${currentData.recentSaveCount || 0} to ${newRecentSaveCount}.`
          );
          writeBatch.update(recipeDoc.ref, { recentSaveCount: newRecentSaveCount });
          writesInCurrentBatch++;
        }

        // Firestore batch limit is 500 operations. Commit before reaching limit.
        if (writesInCurrentBatch >= 490) {
          logger.info(`${logPrefix} Committing batch of ${writesInCurrentBatch} updates.`);
          commitPromises.push(writeBatch.commit());
          totalUpdatesCommitted += writesInCurrentBatch;
          writeBatch = db.batch(); // Start a new batch
          writesInCurrentBatch = 0;
        }
      } // End loop for recipes in current snapshot

      // Commit any remaining writes in the last batch for this snapshot
      if (writesInCurrentBatch > 0) {
        logger.info(`${logPrefix} Committing final batch of ${writesInCurrentBatch} updates for this snapshot.`);
        commitPromises.push(writeBatch.commit());
        totalUpdatesCommitted += writesInCurrentBatch;
      }

      // Wait for all batch commits in this iteration to complete before proceeding
      if (commitPromises.length > 0) {
        await Promise.all(commitPromises);
        logger.info(`${logPrefix} All batch commits for this snapshot completed.`);
      }

      recipesProcessedCount += publicRecipesSnapshot.size;
      if (publicRecipesSnapshot.size < batchSize) {
        logger.info(`${logPrefix} Processed last batch of recipes.`);
        break; // Break if we fetched fewer than batchSize, indicating end of collection
      }
      lastDoc = publicRecipesSnapshot.docs[publicRecipesSnapshot.docs.length - 1];
    } // End while loop

    logger.info(
        `${logPrefix} Finished. Total recipes processed: ${recipesProcessedCount}. ` +
        `Total updates committed: ${totalUpdatesCommitted}.`
    );
    return null;
  } catch (error) {
    logger.error(`${logPrefix} Error during execution:`, error);
    // Re-throwing might be appropriate for scheduled functions to indicate failure to Cloud Scheduler
    // throw error; 
    return null; // Original behavior was to return null
  }
});

module.exports = {
  updateAllRecentSaveCounts,
}; 