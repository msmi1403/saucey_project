const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * Clears the badge count for a user when they open the app
 * @param {string} userId - The user ID
 * @returns {Promise<boolean>} Success status
 */
async function clearUserBadgeCount(userId) {
    if (!userId) {
        logger.warn("clearUserBadgeCount: No userId provided");
        return false;
    }

    try {
        // Update badge count to 0 in user document
        await firestoreHelper.saveDocument("users", userId, {
            badgeCount: 0,
            lastBadgeClearAt: firestoreHelper.Timestamp.now()
        });
        
        logger.info(`Cleared badge count for user ${userId}`, { userId });
        return true;
    } catch (error) {
        logger.error(`Error clearing badge count for user ${userId}:`, { userId, error: error.message });
        return false;
    }
}

module.exports = {
    clearUserBadgeCount
}; 