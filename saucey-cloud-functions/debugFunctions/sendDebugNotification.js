// saucey-cloud-functions/debugNotification/sendDebugNotification.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { logger } = functions; // Using functions.logger

// Firebase Admin SDK should be initialized in the root index.js
// if (admin.apps.length === 0) {
// admin.initializeApp();
// logger.info('Firebase Admin SDK initialized in sendDebugNotification.js'); // Changed to logger.info
// }

const db = admin.firestore();
const messaging = admin.messaging();

// Ensuring the export name matches what's likely used in root index.js for clarity
exports.sendDebugNotification = functions.https.onCall(async (data, context) => {
  logger.info("--- sendDebugNotification invoked ---"); // Changed to logger.info

  // Authentication Check
  if (!context.auth) {
    logger.warn('sendDebugNotification: Unauthenticated access attempt.', { data }); // Changed to logger.warn
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  // Optional: Log authenticated user for auditing
  logger.info('sendDebugNotification: Authenticated user', { userId: context.auth.uid, data }); // Changed to logger.info

  // Safely log keys of the wrapper 'data' object
  // if (data && typeof data === 'object') { // This check is for the outer 'data' which is standard for onCall
    // logger.info("Keys in received 'data' (wrapper) object:", Object.keys(data).join(", "));
  // } else {
    // logger.info("Received 'data' (wrapper) is not an object or is null/undefined.");
  // }

  // Log authentication context (already captured userId, rest can be verbose)
  // logger.info("Authentication context details:", JSON.stringify(context.auth, null, 2));

  // Client payload is expected directly in 'data' for v1 onCall
  // The comment about data.data might have been for a v2 function or a misunderstanding.
  // For v1 onCall, client sends {userId: "...", title: "..."}, and it arrives as 'data' argument.
  const clientPayload = data; 

  if (!clientPayload) {
    logger.error("sendDebugNotification: 'clientPayload' (data) is missing or undefined.", { contextAuth: context.auth }); // Changed to logger.error
    throw new functions.https.HttpsError("invalid-argument", "Client payload (data) is missing. Cannot retrieve arguments.");
  }

  // Now, safely log the clientPayload (which should be a simple JSON object)
  logger.info("Actual clientPayload (data):", { clientPayload: JSON.stringify(clientPayload, null, 2), userId: context.auth.uid }); // Changed to logger.info

  const { userId, title, body, deepLinkTarget } = clientPayload;
  const notificationTitle = title || "Debug Test Title";
  const notificationBody = body || "Debug Test Body from Cloud Function!";
  const deepLink = deepLinkTarget || "saucey://home";

  // Validate userId from payload against authenticated user if they must match
  // For a debug function, often an admin might trigger this for *another* userId.
  // So, we'll proceed with the userId from the payload but ensure it's provided.
  if (!userId) {
    logger.error("sendDebugNotification: userId is missing or falsy within clientPayload.", { clientPayload, contextAuth: context.auth }); // Changed to logger.error
    throw new functions.https.HttpsError("invalid-argument", "The function must be called with a 'userId' argument in the payload.");
  }

  logger.info(`sendDebugNotification: Proceeding for target userId: ${userId}`, { authenticatedUserId: context.auth.uid }); // Changed to logger.info
  logger.info(`Attempting to send notification: Title='${notificationTitle}', Body='${notificationBody}', DeepLink='${deepLink}'`, { targetUserId: userId }); // Changed to logger.info

  try {
    const userDocRef = db.collection("users").doc(userId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      logger.error(`sendDebugNotification: User document not found for target userId: ${userId}`, { authenticatedUserId: context.auth.uid }); // Changed to logger.error
      // For onCall, it's better to throw an HttpsError or return a structured error if that's the API contract.
      // Since this is a debug utility, returning a success:false is acceptable if client expects it.
      // However, to be consistent with HttpsError usage:
      throw new functions.https.HttpsError("not-found", `User document not found for userId: ${userId}`);
    }

    const userData = userDoc.data();
    const fcmTokens = userData?.fcmTokens || [];
    logger.info(`sendDebugNotification: Found FCM tokens for target user ${userId}: ${fcmTokens.length} tokens.`, { authenticatedUserId: context.auth.uid, fcmTokens }); // Changed to logger.info

    if (fcmTokens.length === 0) {
      logger.info(`sendDebugNotification: No FCM tokens found for target user: ${userId}. Cannot send notification.`, { authenticatedUserId: context.auth.uid }); // Changed to logger.info
      // Similar to above, could throw or return structure.
      throw new functions.https.HttpsError("failed-precondition", `User ${userId} has no registered FCM tokens.`);
    }

    const payload = {
      tokens: fcmTokens,
      notification: {
        title: notificationTitle,
        body: notificationBody,
      },
      data: {
        deepLinkTarget: deepLink,
        source: "cloud_function_debug_send",
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    };

    logger.info(`sendDebugNotification: Constructed FCM payload for ${fcmTokens.length} tokens. Notification title: ${notificationTitle}`, { targetUserId: userId, authenticatedUserId: context.auth.uid }); // Changed to logger.info
    const response = await messaging.sendEachForMulticast(payload);
    logger.info(`sendDebugNotification: FCM sendEachForMulticast response for target user ${userId}: Successes: ${response.successCount}, Failures: ${response.failureCount}`, { authenticatedUserId: context.auth.uid }); // Changed to logger.info

    response.responses.forEach((resp, idx) => {
      if (resp.success) {
        logger.info(`sendDebugNotification: Successfully sent message to token [${idx}]: ${fcmTokens[idx]}, Message ID: ${resp.messageId}`, { targetUserId: userId, authenticatedUserId: context.auth.uid }); // Changed to logger.info
      } else {
        logger.error(`sendDebugNotification: Failed to send message to token [${idx}]: ${fcmTokens[idx]}`, { errorInfo: resp.error, targetUserId: userId, authenticatedUserId: context.auth.uid }); // Changed to logger.error
      }
    });

    if (response.failureCount > 0) {
      const tokensToRemove = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const errorCode = resp.error.code;
          if (
            errorCode === "messaging/registration-token-not-registered" ||
            errorCode === "messaging/invalid-registration-token"
          ) {
            tokensToRemove.push(fcmTokens[idx]);
          }
        }
      });

      if (tokensToRemove.length > 0) {
        logger.info(`sendDebugNotification: Tokens to remove for target user ${userId}:`, { tokensToRemove, authenticatedUserId: context.auth.uid }); // Changed to logger.info
        try {
          await userDocRef.update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove),
          });
          logger.info(`sendDebugNotification: Successfully removed ${tokensToRemove.length} invalid FCM tokens for target user ${userId}.`, { authenticatedUserId: context.auth.uid }); // Changed to logger.info
        } catch (tokenCleanupError) {
          logger.error(`sendDebugNotification: Error removing invalid FCM tokens for target user ${userId}:`, { error: tokenCleanupError, authenticatedUserId: context.auth.uid }); // Changed to logger.error
        }
      }
    }

    if (response.successCount > 0) {
      return { success: true, message: `Successfully sent ${response.successCount} message(s). Failures: ${response.failureCount}.` };
    }
    // If successCount is 0 but no errors were thrown before, it implies all were failures handled by FCM reporting.
    throw new functions.https.HttpsError("unavailable", `Failed to send any messages. FCM Failures: ${response.failureCount}. Check function logs for details.`);

  } catch (error) {
    logger.error(`sendDebugNotification: Unhandled error for target userId ${userId}:`, { error, authenticatedUserId: context.auth.uid }); // Changed to logger.error
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    const errorMessageText = (error instanceof Error) ? error.message : "An unknown error occurred";
    throw new functions.https.HttpsError("internal", "An internal error occurred while sending the notification.", { originalError: errorMessageText });
  }
});