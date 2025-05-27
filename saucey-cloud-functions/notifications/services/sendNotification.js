const admin = require('firebase-admin');
const { logger } = require('firebase-functions/v2');
const firestoreHelper = require('@saucey/shared/services/firestoreHelper');
const { notificationConfigs } = require('../config/notificationConfig'); // For default content, deep links etc.
// A/B testing utility functions will be added/imported later
// const { selectABTestVariant, fetchActiveABTestFromFirestore } = require('./abTestUtils'); // Placeholder

/**
 * Dispatches a notification to a user after checking preferences and handling A/B testing.
 *
 * @param {string} userId - The ID of the user to notify.
 * @param {string} notificationTypeKey - The key identifying the notification type (e.g., "weeklyRecipeIdeas").
 *                                      This key MUST match the field names in user's notificationPreferences
 *                                      and keys in notificationConfigs.
 * @param {object} [dynamicData={}] - Data for personalizing content (e.g., { recipeName: "Spicy Tacos" }).
 * @param {object} [aiGeneratedContent=null] - Optional AI-generated content to override defaults/variants.
 *                                           Expected structure: { title: string, body: string, emoji?: string }
 * @returns {Promise<boolean>} True if the notification was processed for sending, false otherwise (e.g., disabled).
 */
async function dispatchNotification(userId, notificationTypeKey, dynamicData = {}, aiGeneratedContent = null) {
  logger.info(`Dispatching notification: type='${notificationTypeKey}', user='${userId}'`, { userId, notificationTypeKey, dynamicData, hasAiContent: !!aiGeneratedContent });

  // 1. Fetch User Document and Notification Configuration
  const userDoc = await firestoreHelper.getDocument('users', userId);
  if (!userDoc) {
    logger.warn(`User document not found for userId: ${userId}. Cannot send notification.`, { userId, notificationTypeKey });
    return false;
  }

  const baseConfig = notificationConfigs[notificationTypeKey];
  if (!baseConfig) {
    logger.warn(`No base configuration found for notificationTypeKey: '${notificationTypeKey}'. Cannot send notification.`, { userId, notificationTypeKey });
    return false;
  }
  if (baseConfig.isEnabled === false) { // Check general enabled flag in config
    logger.info(`Notification type '${notificationTypeKey}' is globally disabled in notificationConfig.js.`, { userId, notificationTypeKey });
    return false;
  }

  // 2. Check User's Notification Preferences
  const userPreferences = userDoc.notificationPreferences || {}; // Default to empty object if no preferences set

  // Check if all notifications are disabled by a master toggle (if you implement one like 'disableAllNotifications')
  // Example: if (userPreferences.disableAllNotifications === true) {
  //   logger.info(`User ${userId} has all notifications disabled via master toggle.`, { userId, notificationTypeKey });
  //   return false;
  // }

  // Check for the specific notification type preference
  // IMPORTANT: Assumes 'true' or missing key means enabled (opt-out).
  // If a key is present and explicitly 'false', it's disabled.
  if (userPreferences[notificationTypeKey] === false) {
    logger.info(`User ${userId} has disabled notification type '${notificationTypeKey}'.`, { userId, notificationTypeKey });
    return false;
  }
  logger.debug(`User ${userId} preference for '${notificationTypeKey}': ${userPreferences[notificationTypeKey] === undefined ? 'Not set (defaulting to enabled)' : userPreferences[notificationTypeKey]}. Proceeding.`, { userId, notificationTypeKey });


  // 3. Fetch FCM Tokens
  const fcmTokens = userDoc.fcmTokens;
  if (!Array.isArray(fcmTokens) || fcmTokens.length === 0) {
    logger.warn(`No FCM tokens found for user ${userId}. Cannot send notification.`, { userId, notificationTypeKey });
    return false;
  }

  // --- A/B Testing, Content Personalization, Deep Link and FCM Sending Logic --- 

  let content = { ...baseConfig.defaultContent }; // Start with default content from config
  let experimentId = null;
  // Use a more descriptive default, or a specific one if a suggestion strategy is part of dynamicData
  let variantId = dynamicData.suggestionStrategy ? `${dynamicData.suggestionStrategy}_defaultBase` : "default_base_content";

  // A. A/B Test Logic (adapted from notificationSender.js)
  const firestoreABTest = await fetchActiveABTestFromFirestore(notificationTypeKey);
  let selectedVariant = null;

  if (firestoreABTest?.variants?.length > 0) {
    selectedVariant = selectABTestVariant(firestoreABTest.variants);
    if (selectedVariant) {
      content = {
        title: selectedVariant.title,
        body: selectedVariant.body,
        emoji: selectedVariant.emoji || baseConfig.defaultContent.emoji, // Fallback to base emoji
        deepLink: selectedVariant.deepLink // Variant specific deep link
      };
      experimentId = firestoreABTest.experimentId;
      variantId = selectedVariant.variantId;
      logger.info(`A/B Test (Firestore): User ${userId} assigned to variant '${variantId}' for experiment '${experimentId}'.`, { userId, notificationTypeKey, experimentId, variantId });
    }
  } else if (baseConfig.abTest?.isActive && baseConfig.abTest?.variants?.length > 0) {
    // Fallback to A/B test defined in notificationConfig.js if no active Firestore experiment
    selectedVariant = selectABTestVariant(baseConfig.abTest.variants);
    if (selectedVariant) {
      content = {
        title: selectedVariant.content.title, // Note: structure is nested under 'content' here
        body: selectedVariant.content.body,
        emoji: selectedVariant.content.emoji || baseConfig.defaultContent.emoji,
        deepLink: selectedVariant.content.deepLink
      };
      experimentId = baseConfig.abTest.experimentId;
      variantId = selectedVariant.variantId;
      logger.info(`A/B Test (Config File): User ${userId} assigned to variant '${variantId}' for experiment '${experimentId}'.`, { userId, notificationTypeKey, experimentId, variantId });
    }
  }

  // B. Apply AI Content if provided (this overrides A/B test title/body/emoji)
  if (aiGeneratedContent?.title && aiGeneratedContent?.body) {
    content.title = aiGeneratedContent.title;
    content.body = aiGeneratedContent.body;
    content.emoji = aiGeneratedContent.emoji || content.emoji; // AI emoji or fallback to A/B/default emoji
    
    if (!experimentId) { // No A/B test was active
      variantId = dynamicData.suggestionStrategy ? `${dynamicData.suggestionStrategy}_ai_generated` : "ai_generated_direct";
    } else { // A/B test was active, AI content enhances it
      variantId = `${variantId}_ai_enhanced`;
    }
    logger.info(`AI-generated content applied for user '${userId}', type '${notificationTypeKey}'. New Variant ID: '${variantId}'`, { userId, notificationTypeKey, variantId });
  } else {
    // If no AI content and no A/B test selected, ensure variantId reflects the origin if not already set by A/B
    if (!experimentId && variantId === (dynamicData.suggestionStrategy ? `${dynamicData.suggestionStrategy}_defaultBase` : "default_base_content")) {
        variantId = dynamicData.suggestionStrategy ? `${dynamicData.suggestionStrategy}_default_config` : "default_from_config";
    }
  }

  // C. Personalize Content (replace placeholders in title/body)
  // Define placeholders based on dynamicData. Ensure keys match those in content strings.
  const placeholders = {
    '{RECIPE_NAME}': dynamicData.recipeName || dynamicData.recipeIdea || dynamicData.originalRecipeNameForRemixDisplay || '',
    '{CREATOR_NAME}': dynamicData.creatorName || '',
    '{MEAL_TYPE}': dynamicData.mealType || '',
    '{RECIPE_IDEA_OR_REMIX}': dynamicData.recipeIdea || dynamicData.remixIdea || '',
    // Add any other common placeholders you might use
    '{USER_FIRST_NAME}': userDoc.firstName || dynamicData.firstName || '', // Example: if you store firstName on userDoc
  };

  // Replace placeholders in title
  if (content.title) {
    content.title = Object.entries(placeholders).reduce((acc, [key, value]) => {
        return acc.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }, content.title);
  }
  // Replace placeholders in body
  if (content.body) {
    content.body = Object.entries(placeholders).reduce((acc, [key, value]) => {
        return acc.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }, content.body);
  }

  // D. Determine Deep Link (adapted from notificationSender.js)
  // Priority: dynamicData.deepLinkOverride > content.deepLink (from A/B/AI) > constructed from baseConfig > baseConfig.defaultDeepLinkBase > fallback.
  let finalDeepLink = dynamicData.deepLinkOverride;
  if (!finalDeepLink) {
    if (content.deepLink) {
      finalDeepLink = content.deepLink;
    } else if (dynamicData.recipeId && baseConfig.defaultDeepLinkBase) {
      // Construct recipe-specific deep link if recipeId is available and a base is defined
      finalDeepLink = baseConfig.defaultDeepLinkBase.endsWith('/') ?
                      `${baseConfig.defaultDeepLinkBase}${dynamicData.recipeId}` :
                      `${baseConfig.defaultDeepLinkBase}/${dynamicData.recipeId}`;
    } else if (baseConfig.defaultDeepLinkBase) {
      finalDeepLink = baseConfig.defaultDeepLinkBase;
    }
  }
  finalDeepLink = finalDeepLink || 'saucey://home'; // Absolute fallback

  logger.debug(`Personalized content ready. Title: "${content.title}", Body: "${content.body}". Deep Link: "${finalDeepLink}"`, { userId, notificationTypeKey, finalDeepLink });

  // E. Construct FCM Payload
  const fcmPayload = {
    notification: {
      title: `${content.emoji ? content.emoji + " " : ""}${content.title || 'Update from Saucey'}`,
      body: content.body || 'Check out what\'s new!',
    },
    data: {
      notificationType: notificationTypeKey,
      userId: userId, // Useful for client-side handling if needed
      deepLink: finalDeepLink,
      sentAt: admin.firestore.Timestamp.now().toMillis().toString(),
      ...(experimentId && { experimentId: experimentId }), // Conditionally add experimentId
      // Add variantId if it's not one of the truly generic defaults to avoid cluttering logs for simple notifications
      ...((variantId && !["default_base_content", "default_from_config"].includes(variantId)) && { variantId: variantId }),
      ...(dynamicData.suggestionStrategy && { suggestionStrategy: dynamicData.suggestionStrategy }),
      // Include any other critical dynamicData fields that the client might need directly from the data payload
      ...(dynamicData.recipeId && { recipeId: dynamicData.recipeId }),
    },
    tokens: fcmTokens, // Array of FCM registration tokens for the user
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1, // Or manage badge count more dynamically if needed
          "content-available": baseConfig.isContentAvailable || 0, // e.g. for background updates, from config
        },
      },
    },
    android: {
      notification: {
        sound: "default",
        // Add other Android-specific options if needed from baseConfig
        ...(baseConfig.androidChannelId && { channelId: baseConfig.androidChannelId }),
      },
    },
  };

  // F. Send via FCM & Handle Response
  try {
    const response = await admin.messaging().sendEachForMulticast(fcmPayload);
    logger.info(`FCM send attempt for '${notificationTypeKey}' to user '${userId}'. Success: ${response.successCount}, Failures: ${response.failureCount}.`, 
                { userId, notificationTypeKey, successCount: response.successCount, failureCount: response.failureCount, variantId, experimentId });

    const tokensToRemove = [];
    response.responses.forEach((result, index) => {
      if (!result.success) {
        logger.warn(`Failed to send to token ${fcmTokens[index]} for user '${userId}'. Code: ${result.error?.code}, Message: ${result.error?.message}`, 
                    { userId, notificationTypeKey, token: fcmTokens[index], errorCode: result.error?.code });
        // Standard error codes indicating an invalid or unregistered token
        const invalidTokenErrorCodes = [
          "messaging/invalid-registration-token",
          "messaging/registration-token-not-registered",
          "messaging/mismatched-credential", // Though this might also indicate server key issues
        ];
        if (result.error && invalidTokenErrorCodes.includes(result.error.code)) {
          tokensToRemove.push(fcmTokens[index]);
        }
      }
    });

    if (tokensToRemove.length > 0) {
      logger.info(`Removing ${tokensToRemove.length} invalid FCM tokens for user ${userId}.`, { userId, count: tokensToRemove.length });
      // Update user document to remove these tokens
      await firestoreHelper.updateDocument("users", userId, {
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove),
      });
    }

    // G. Log Sent Notification (even if some tokens failed, log the attempt and overall success/failure)
    // Create a subcollection for sent notifications for better querying and scalability
    const logEntry = {
      notificationType: notificationTypeKey,
      title: content.title || 'N/A',
      body: content.body || 'N/A',
      emoji: content.emoji || null,
      deepLink: finalDeepLink,
      experimentId: experimentId || null,
      variantId: variantId,
      suggestionStrategy: dynamicData.suggestionStrategy || null,
      fcmMessageIds: response.responses.filter(r => r.success && r.messageId).map(r => r.messageId),
      status: response.successCount > 0 ? "partial_success" : "all_failed", // More granular status
      sentAt: admin.firestore.Timestamp.now(),
      originalTokenCount: fcmTokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      userId: userId, // For querying logs by user if stored in a central collection
    };
    if (response.successCount > 0) logEntry.status = "sent_successfully"; // If at least one succeeded
    if (response.failureCount === fcmTokens.length) logEntry.status = "all_failed";
    else if (response.failureCount > 0) logEntry.status = "partial_success";

    await firestoreHelper.addDocument(`users/${userId}/sentNotificationsLog`, logEntry);
    logger.info(`Notification attempt logged for user '${userId}', type '${notificationTypeKey}'.`, { userId, notificationTypeKey, logId: logEntry.id /* if helper returns it */ });

    return response.successCount > 0; // Return true if at least one notification was sent

  } catch (error) {
    logger.error(`Major error sending multicast message for '${notificationTypeKey}' to user '${userId}':`, { userId, notificationTypeKey, errorMessage: error.message, errorStack: error.stack });
    return false; // Indicate failure of the dispatch attempt
  }
}

// --- Helper functions for A/B Testing (copied from notificationSender.js) ---

/**
 * Selects a variant from a list based on weights.
 * @param {Array<object>} variants - Array of variant objects with a 'weight' property.
 * @returns {object|null} The selected variant object or null.
 */
function selectABTestVariant(variants) {
    if (!variants || variants.length === 0) {
        return null;
    }
    const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 0), 0);
    if (totalWeight === 0) {
        // If all weights are 0, pick one uniformly at random
        return variants[Math.floor(Math.random() * variants.length)];
    }
    let randomNum = Math.random() * totalWeight;
    for (const variant of variants) {
        if (randomNum < (variant.weight || 0)) {
            return variant;
        }
        randomNum -= (variant.weight || 0);
    }
    // Fallback, should ideally not be reached if weights are positive
    return variants[variants.length - 1]; 
}

/**
 * Fetches active A/B test configuration from Firestore for a given notification type.
 * @param {string} notificationType - The type of notification (e.g., "weeklyRecipeSuggestion").
 * @returns {Promise<object|null>} The experiment data or null if not found/error.
 */
async function fetchActiveABTestFromFirestore(notificationType) {
    try {
        const experimentsSnapshot = await firestoreHelper.getCollection("ab_test_experiments", {
            where: [
                { field: "notificationType", operator: "==", value: notificationType },
                { field: "isActive", operator: "==", value: true }
            ],
            limit: 1 // Expecting only one active experiment per type
        });

        if (experimentsSnapshot.length > 0) {
            const experimentData = experimentsSnapshot[0]; // getDocument in helper returns array
            logger.info(`Found active A/B test in Firestore for type '${notificationType}': ${experimentData.experimentId}`, { notificationType, experimentId: experimentData.experimentId });
            return experimentData;
        }
        logger.info(`No active A/B test found in Firestore for type '${notificationType}'.`, { notificationType });
        return null;
    } catch (error) {
        logger.error(`Error fetching A/B test from Firestore for type '${notificationType}':`, { notificationType, errorMessage: error.message, errorStack: error.stack });
        return null; // Return null on error to allow fallback to config or default
    }
}

module.exports = {
  dispatchNotification,
}; 