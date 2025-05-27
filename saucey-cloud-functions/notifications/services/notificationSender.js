// saucey-cloud-functions/notifications/services/notificationSender.js
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const { notificationConfigs } = require("../config/notificationConfig");

// selectABTestVariant function remains the same
function selectABTestVariant(variants) {
    if (!variants || variants.length === 0) {
        return null;
    }
    const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 0), 0);
    if (totalWeight === 0) {
        return variants[Math.floor(Math.random() * variants.length)];
    }
    let randomNum = Math.random() * totalWeight;
    for (const variant of variants) {
        if (randomNum < (variant.weight || 0)) {
            return variant;
        }
        randomNum -= (variant.weight || 0);
    }
    return variants[variants.length - 1];
}

// fetchActiveABTestFromFirestore function remains the same
async function fetchActiveABTestFromFirestore(notificationType) {
    try {
        const experimentsSnapshot = await firestoreHelper.getCollection("ab_test_experiments", {
            where: [
                { field: "notificationType", operator: "==", value: notificationType },
                { field: "isActive", operator: "==", value: true }
            ],
            limit: 1
        });
        if (experimentsSnapshot.length > 0) {
            const experimentData = experimentsSnapshot[0];
            logger.log(`Found active A/B test in Firestore for type '${notificationType}': ${experimentData.experimentId}`);
            return experimentData;
        }
        logger.log(`No active A/B test found in Firestore for type '${notificationType}'.`);
        return null;
    } catch (error) {
        logger.error(`Error fetching A/B test from Firestore for type '${notificationType}':`, error);
        return null;
    }
}

async function sendTargetedNotification(userId, notificationType, aiGeneratedContent = null, dynamicData = {}) {
    logger.log(`Attempting to send notification type '${notificationType}' to user '${userId}' with dynamicData:`, JSON.stringify(dynamicData));

    const baseConfig = notificationConfigs[notificationType];
    if (!baseConfig || !baseConfig.isEnabled) {
        logger.warn(`Notification type '${notificationType}' is not configured or is disabled in notificationConfig.js.`);
        return;
    }

    const userDoc = await firestoreHelper.getDocument("users", userId);
    if (!userDoc) { /* ... user not found logic ... */ return; }
    if (userDoc.notificationPreferences?.disableAll === true) { /* ... disabled all ... */ return; }
    if (userDoc.notificationPreferences?.[notificationType] === false) { /* ... type disabled ... */ return; }

    const fcmTokens = userDoc.fcmTokens;
    if (!fcmTokens || fcmTokens.length === 0) { /* ... no tokens ... */ return; }

    let content = { ...baseConfig.defaultContent };
    let experimentId = null;
    let variantId = "default_initial";

    const firestoreABTest = await fetchActiveABTestFromFirestore(notificationType);
    let selectedVariant = null;

    if (firestoreABTest?.variants?.length > 0) {
        selectedVariant = selectABTestVariant(firestoreABTest.variants);
        if (selectedVariant) {
            content = {
                title: selectedVariant.title,
                body: selectedVariant.body,
                emoji: selectedVariant.emoji || baseConfig.defaultContent.emoji,
                deepLink: selectedVariant.deepLink // Variant specific deep link
            };
            experimentId = firestoreABTest.experimentId;
            variantId = selectedVariant.variantId;
            logger.log(`A/B Test (Firestore): User ${userId} assigned to variant ${variantId} for experiment ${experimentId}`);
        }
    } else if (baseConfig.abTest?.isActive && baseConfig.abTest?.variants?.length > 0) {
        selectedVariant = selectABTestVariant(baseConfig.abTest.variants);
        if (selectedVariant) {
            content = {
                title: selectedVariant.content.title,
                body: selectedVariant.content.body,
                emoji: selectedVariant.content.emoji || baseConfig.defaultContent.emoji,
                deepLink: selectedVariant.content.deepLink
            };
            experimentId = baseConfig.abTest.experimentId;
            variantId = selectedVariant.variantId;
            logger.log(`A/B Test (Config File): User ${userId} assigned to variant ${variantId} for experiment ${experimentId}`);
        }
    }

    if (aiGeneratedContent?.title && aiGeneratedContent?.body) {
        content.title = aiGeneratedContent.title;
        content.body = aiGeneratedContent.body;
        content.emoji = aiGeneratedContent.emoji || content.emoji;
        if (!experimentId) {
             variantId = dynamicData.suggestionStrategy ? `${dynamicData.suggestionStrategy}_ai_generated` : "ai_generated_content";
        } else {
            variantId = `${variantId}_ai_enhanced`;
        }
        logger.log(`AI content applied for user ${userId}, type ${notificationType}. Variant/Source: ${variantId}`);
    } else {
        if (!experimentId && variantId === "default_initial") {
            variantId = dynamicData.suggestionStrategy ? `${dynamicData.suggestionStrategy}_default` : "default_content";
        }
    }

    // Personalize content (placeholders in title/body from A/B or default)
    const placeholders = {
        "{RECIPE_NAME}": dynamicData.recipeName || dynamicData.recipeIdea || dynamicData.originalRecipeNameForRemixDisplay || "",
        "{CREATOR_NAME}": dynamicData.creatorName || "",
        "{MEAL_TYPE}": dynamicData.mealType || "",
        "{RECIPE_IDEA_OR_REMIX}": dynamicData.recipeIdea || dynamicData.remixIdea || ""
    };
    content.title = (content.title || "").replace(/{RECIPE_NAME}|{CREATOR_NAME}|{MEAL_TYPE}|{RECIPE_IDEA_OR_REMIX}/g, match => placeholders[match] || "");
    content.body = (content.body || "").replace(/{RECIPE_NAME}|{CREATOR_NAME}|{MEAL_TYPE}|{RECIPE_IDEA_OR_REMIX}/g, match => placeholders[match] || "");


    // --- DEEP LINK LOGIC ---
    // Prioritize deepLinkOverride passed from the trigger function if it exists
    let finalDeepLink = dynamicData.deepLinkOverride ||
                        content.deepLink || // Then variant/default specific deepLink from content object
                        (dynamicData.recipeId && baseConfig.defaultDeepLinkBase ? // Then constructed recipe deep link
                            (baseConfig.defaultDeepLinkBase.endsWith('/') ?
                                `${baseConfig.defaultDeepLinkBase}${dynamicData.recipeId}` :
                                `${baseConfig.defaultDeepLinkBase}/${dynamicData.recipeId}`) :
                            null) ||
                        baseConfig.defaultDeepLinkBase ||  // Then base config default deep link
                        "saucey://home";                   // Absolute fallback

    logger.log(`Final deep link for ${notificationType} to user ${userId}: ${finalDeepLink}`);


    const fcmPayload = {
        notification: {
            title: `${content.emoji ? content.emoji + " " : ""}${content.title}`,
            body: content.body,
        },
        data: {
            notificationType: notificationType,
            userId: userId,
            deepLink: finalDeepLink,
            sentAt: admin.firestore.Timestamp.now().toMillis().toString(),
            ...(experimentId && { experimentId: experimentId }),
            ...(variantId !== "default_content" && variantId !== "existingRecipe_default" && { variantId: variantId }),
        },
        tokens: fcmTokens,
        apns: { payload: { aps: { sound: "default", badge: 1, "content-available": 1 } } },
        android: { notification: { sound: "default" } },
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(fcmPayload);
        logger.info(`FCM response for '${notificationType}' to user '${userId}': Successes: ${response.successCount}, Failures: ${response.failureCount}. Variant: ${variantId}, Experiment: ${experimentId || 'N/A'}`);

        const tokensToRemove = [];
        response.responses.forEach((result, index) => {
            if (!result.success) {
                logger.error(`Failed to send to token ${fcmTokens[index]}: Code: ${result.error?.code}, Message: ${result.error?.message}`);
                const invalidTokenErrors = ["messaging/invalid-registration-token", "messaging/registration-token-not-registered", "messaging/mismatched-credential"];
                if (result.error && invalidTokenErrors.includes(result.error.code)) {
                    tokensToRemove.push(fcmTokens[index]);
                }
            }
        });

        if (tokensToRemove.length > 0) {
            logger.info(`Removing ${tokensToRemove.length} invalid FCM tokens for user ${userId}.`);
            await firestoreHelper.updateDocument("users", userId, {
                fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove),
            });
        }

        await firestoreHelper.addDocument(`users/${userId}/sentNotificationsLog`, {
            notificationType: notificationType,
            title: content.title,
            body: content.body,
            emoji: content.emoji || null,
            deepLink: fcmPayload.data.deepLink,
            experimentId: experimentId || null,
            variantId: variantId,
            suggestionStrategy: dynamicData.suggestionStrategy || null, // Log the strategy used
            fcmMessageIds: response.responses.filter(r => r.success && r.messageId).map(r => r.messageId),
            status: "sent",
            sentAt: admin.firestore.Timestamp.now(),
            fcmTokenCount: fcmTokens.length,
            successCount: response.successCount,
            failureCount: response.failureCount,
        });

    } catch (error) {
        logger.error(`Error sending multicast message for '${notificationType}' to user '${userId}':`, error);
    }
}

module.exports = {
    sendTargetedNotification,
};
