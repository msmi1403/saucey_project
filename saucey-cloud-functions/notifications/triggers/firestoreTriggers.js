// saucey-cloud-functions/notifications/triggers/firestoreTriggers.js
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const { analyzeUserActivityAndPrefs } = require("../aiLogic/userAnalyzer");
const { generateNotificationContent } = require("../aiLogic/notificationGenerator");
const { dispatchNotification } = require("../services/sendNotification");
const { notificationConfigs } = require("../config/notificationConfig");

const NEW_RECIPE_FROM_CREATOR = "newRecipeFromCreator";

// Example: Notify followers when a creator publishes a new recipe
// Assumes 'recipes' collection and a way to get followers of a creator.
// Firestore structure for followers could be:
// /users/{creatorId}/followers/{followerUserId} (document with followerId)
// OR /creators/{creatorId}/followers/{followerUserId}
// OR recipes have a 'creatorProfileId' and users have a 'followedCreators' array.
// Let's assume the third option for simplicity: users/{userId}/followedCreators: [creatorId1, creatorId2]
exports.notifyFollowersOnNewRecipe = onDocumentCreated("recipes/{recipeId}", async (event) => {
    logger.log(`New recipe created trigger for recipeId: ${event.params.recipeId}`);

    const config = notificationConfigs[NEW_RECIPE_FROM_CREATOR];
    if (!config || !config.isEnabled) {
        logger.warn(`${NEW_RECIPE_FROM_CREATOR} is not configured or disabled. Exiting.`);
        return null;
    }

    const snapshot = event.data;
    if (!snapshot) {
        logger.log("No data associated with the event for new recipe.");
        return null;
    }
    const recipeData = snapshot.data();
    const recipeId = event.params.recipeId;

    // Ensure it's a public recipe if that's the intent for this notification type
    // This depends on your business logic - if only *public* new recipes trigger this.
    // Assuming 'isPublic' field exists. If not, adjust or remove this check.
    if (recipeData.isPublic !== true) {
        logger.log(`Recipe ${recipeId} is not public. No follower notifications will be sent.`);
        return null;
    }

    if (!recipeData.creatorId || !recipeData.name) {
        logger.warn("New recipe data is missing creatorId or name. Cannot send notifications.", { recipeId, recipeData });
        return null;
    }

    const creatorId = recipeData.creatorId;
    const recipeName = recipeData.name;

    const creatorProfile = await firestoreHelper.getDocument("users", creatorId);
    const creatorName = creatorProfile?.displayName || "A Saucey Chef";

    try {
        const followersSnapshot = await firestoreHelper.getCollection("users", {
            where: [{ field: "followedCreators", operator: "array-contains", value: creatorId }]
        });

        if (followersSnapshot.length === 0) {
            logger.log(`No followers found for creator ${creatorId} to notify about recipe ${recipeName}.`);
            return null;
        }

        logger.log(`Found ${followersSnapshot.length} followers for creator ${creatorId}. Notifying them about recipe '${recipeName}' (ID: ${recipeId}).`);

        for (const followerDoc of followersSnapshot) {
            if (followerDoc.id === creatorId) {
                 logger.debug(`Skipping notification to creator ${creatorId} (themselves).`);
                 continue;
            }
            // Most checks (fcmTokens, preferences) are now handled by dispatchNotification.
            logger.log(`Processing follower ${followerDoc.id} for new recipe from ${creatorName}`);

            const userContext = await analyzeUserActivityAndPrefs(followerDoc.id, followerDoc);
            if (!userContext) {
                logger.warn(`Could not generate context for follower ${followerDoc.id}. Skipping.`);
                continue;
            }

            const dynamicData = {
                recipeId: recipeId,
                recipeName: recipeName,
                creatorName: creatorName,
                suggestionStrategy: "newFromCreator" // For logging/analytics
                // deepLinkOverride will be constructed by dispatchNotification using recipeId and defaultDeepLinkBase
            };

            const aiContent = await generateNotificationContent(
                NEW_RECIPE_FROM_CREATOR,
                userContext, 
                dynamicData
            );

            if (aiContent?.title && aiContent?.body) {
                logger.info(`Dispatching ${NEW_RECIPE_FROM_CREATOR} to follower ${followerDoc.id} for recipe ${recipeId}.`, 
                            { followerId: followerDoc.id, recipeId, creatorName });
                await dispatchNotification(
                    followerDoc.id, 
                    NEW_RECIPE_FROM_CREATOR, 
                    dynamicData, 
                    aiContent
                );
            } else {
                logger.warn(`AI content generation failed for ${NEW_RECIPE_FROM_CREATOR} for follower ${followerDoc.id}. Skipping.`);
            }
        }
        logger.log(`Finished notifying followers for new recipe ${recipeId} from creator ${creatorId}.`);
        return null;
    } catch (error) {
        logger.error(`Error in ${NEW_RECIPE_FROM_CREATOR} trigger for recipe ${recipeId}:`, error);
        return null;
    }
});

// Add more Firestore-triggered notification functions as needed