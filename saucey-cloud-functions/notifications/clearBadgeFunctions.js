const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { clearUserBadgeCount } = require("./services/clearBadgeCount");

/**
 * Cloud function to clear badge count when user opens the app
 * Called from iOS app when app becomes active
 */
exports.clearBadgeCount = onCall(
    {
        region: "us-central1",
        memory: "256MiB",
        timeoutSeconds: 60,
    },
    async (request) => {
        const { auth, data } = request;
        
        // Verify authentication
        if (!auth) {
            logger.warn("clearBadgeCount: Unauthenticated request");
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const userId = auth.uid;
        logger.info(`clearBadgeCount: Request from user ${userId}`);

        try {
            const success = await clearUserBadgeCount(userId);
            
            if (success) {
                return {
                    success: true,
                    message: "Badge count cleared successfully",
                    userId: userId
                };
            } else {
                throw new HttpsError("internal", "Failed to clear badge count");
            }
        } catch (error) {
            logger.error(`clearBadgeCount: Error for user ${userId}:`, { userId, error: error.message });
            throw new HttpsError("internal", "Failed to clear badge count");
        }
    }
); 