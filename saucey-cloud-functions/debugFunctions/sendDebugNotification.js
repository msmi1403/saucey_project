// saucey-cloud-functions/debugFunctions/sendDebugNotification.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions"); // logger can still be from v1 or use console.log for v2

// Firebase Admin SDK should be initialized in the root index.js
// if (admin.apps.length === 0) {
// admin.initializeApp();
// logger.info('Firebase Admin SDK initialized in sendDebugNotification.js'); // Changed to logger.info
// }

const db = admin.firestore();
const messaging = admin.messaging();

// Renaming to match iOS call
exports.sendDebugNotificationToUser = onCall(async (request) => { // Changed to onCall(request)
  logger.info("--- sendDebugNotificationToUser (v2) invoked ---");

  // Authentication Check
  if (!request.auth) { // Changed to request.auth
    logger.warn('sendDebugNotificationToUser: Unauthenticated access attempt.', { data: request.data });
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.'); // Changed to HttpsError
  }
  logger.info('sendDebugNotificationToUser: Authenticated user', { userId: request.auth.uid, data: request.data });

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
  const clientPayload = request.data; // Changed to request.data

  if (!clientPayload) {
    logger.error("sendDebugNotificationToUser: 'clientPayload' (request.data) is missing or undefined.", { contextAuth: request.auth });
    throw new HttpsError("invalid-argument", "Client payload (request.data) is missing. Cannot retrieve arguments.");
  }

  // Now, safely log the clientPayload (which should be a simple JSON object)
  logger.info("Actual clientPayload (request.data):", { clientPayload: JSON.stringify(clientPayload, null, 2), userId: request.auth.uid });

  const { userId, title, body, deepLinkTarget } = clientPayload;
  const notificationTitle = title || "Debug Test Title";
  const notificationBody = body || "Debug Test Body from Cloud Function!";
  const deepLink = deepLinkTarget || "saucey://home";

  // Validate userId from payload against authenticated user if they must match
  // For a debug function, often an admin might trigger this for *another* userId.
  // So, we'll proceed with the userId from the payload but ensure it's provided.
  if (!userId) {
    logger.error("sendDebugNotificationToUser: userId is missing or falsy within clientPayload.", { clientPayload, contextAuth: request.auth });
    throw new HttpsError("invalid-argument", "The function must be called with a 'userId' argument in the payload.");
  }

  logger.info(`sendDebugNotificationToUser: Proceeding for target userId: ${userId}`, { authenticatedUserId: request.auth.uid });
  logger.info(`Attempting to send notification: Title='${notificationTitle}', Body='${notificationBody}', DeepLink='${deepLink}'`, { targetUserId: userId });

  try {
    const userDocRef = db.collection("users").doc(userId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      logger.error(`sendDebugNotificationToUser: User document not found for target userId: ${userId}`, { authenticatedUserId: request.auth.uid });
      // For onCall, it's better to throw an HttpsError or return a structured error if that's the API contract.
      // Since this is a debug utility, returning a success:false is acceptable if client expects it.
      // However, to be consistent with HttpsError usage:
      throw new HttpsError("not-found", `User document not found for userId: ${userId}`);
    }

    const userData = userDoc.data();
    const fcmTokens = userData?.fcmTokens || [];
    logger.info(`sendDebugNotificationToUser: Found FCM tokens for target user ${userId}: ${fcmTokens.length} tokens.`, { authenticatedUserId: request.auth.uid, fcmTokens });

    if (fcmTokens.length === 0) {
      logger.info(`sendDebugNotificationToUser: No FCM tokens found for target user: ${userId}. Cannot send notification.`, { authenticatedUserId: request.auth.uid });
      // Similar to above, could throw or return structure.
      throw new HttpsError("failed-precondition", `User ${userId} has no registered FCM tokens.`);
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

    logger.info(`sendDebugNotificationToUser: Constructed FCM payload for ${fcmTokens.length} tokens. Notification title: ${notificationTitle}`, { targetUserId: userId, authenticatedUserId: request.auth.uid });
    const response = await messaging.sendEachForMulticast(payload);
    logger.info(`sendDebugNotificationToUser: FCM sendEachForMulticast response for target user ${userId}: Successes: ${response.successCount}, Failures: ${response.failureCount}`, { authenticatedUserId: request.auth.uid });

    response.responses.forEach((resp, idx) => {
      if (resp.success) {
        logger.info(`sendDebugNotificationToUser: Successfully sent message to token [${idx}]: ${fcmTokens[idx]}, Message ID: ${resp.messageId}`, { targetUserId: userId, authenticatedUserId: request.auth.uid });
      } else {
        logger.error(`sendDebugNotificationToUser: Failed to send message to token [${idx}]: ${fcmTokens[idx]}`, { errorInfo: resp.error, targetUserId: userId, authenticatedUserId: request.auth.uid });
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
        logger.info(`sendDebugNotificationToUser: Tokens to remove for target user ${userId}:`, { tokensToRemove, authenticatedUserId: request.auth.uid });
        try {
          await userDocRef.update({
            fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove),
          });
          logger.info(`sendDebugNotificationToUser: Successfully removed ${tokensToRemove.length} invalid FCM tokens for target user ${userId}.`, { authenticatedUserId: request.auth.uid });
        } catch (tokenCleanupError) {
          logger.error(`sendDebugNotificationToUser: Error removing invalid FCM tokens for target user ${userId}:`, { error: tokenCleanupError, authenticatedUserId: request.auth.uid });
        }
      }
    }

    if (response.successCount > 0) {
      return { success: true, message: `Successfully sent ${response.successCount} message(s). Failures: ${response.failureCount}.` };
    }
    // If successCount is 0 but no errors were thrown before, it implies all were failures handled by FCM reporting.
    throw new HttpsError("unavailable", `Failed to send any messages. FCM Failures: ${response.failureCount}. Check function logs for details.`);

  } catch (error) {
    logger.error(`sendDebugNotificationToUser: Unhandled error for target userId ${userId}:`, { error, authenticatedUserId: request.auth.uid });
    if (error instanceof HttpsError) { // Check against the imported HttpsError
      throw error;
    }
    const errorMessageText = (error instanceof Error) ? error.message : "An unknown error occurred";
    throw new HttpsError("internal", "An internal error occurred while sending the notification.", { originalError: errorMessageText });
  }
});