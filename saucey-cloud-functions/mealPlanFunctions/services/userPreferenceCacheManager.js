const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");

/**
 * @fileoverview User Preference Cache Manager for optimizing meal planning performance
 * Provides 24-hour caching with smart invalidation and background updates
 */

class UserPreferenceCacheManager {

    constructor() {
        this.CACHE_TTL_HOURS = 24; // 24-hour cache TTL
        this.CACHE_COLLECTION = 'user_preference_cache';
        this.INVALIDATION_EVENTS = [
            'recipe_saved', 'recipe_cooked', 'recipe_viewed',
            'meal_plan_generated', 'cookbook_updated'
        ];
    }

    /**
     * Gets user preferences with caching logic
     * @param {string} userId - User identifier
     * @param {function} generateProfileFunction - Function to generate fresh profile
     * @returns {Promise<object>} User preference profile
     */
    async getCachedUserPreferences(userId, generateProfileFunction) {
        logger.info(`PreferenceCacheManager: Checking cache for user ${userId}`);

        try {
            // Check if valid cache exists
            const cachedProfile = await this.getValidCachedProfile(userId);
            
            if (cachedProfile) {
                logger.info(`PreferenceCacheManager: Using cached profile for ${userId} (age: ${this.getCacheAgeHours(cachedProfile.cacheMetadata)}h)`);
                
                // Trigger background update if cache is getting stale (>18 hours)
                if (this.shouldTriggerBackgroundUpdate(cachedProfile.cacheMetadata)) {
                    this.triggerBackgroundUpdate(userId, generateProfileFunction);
                }
                
                return cachedProfile.profile;
            }

            // No valid cache - generate fresh profile
            logger.info(`PreferenceCacheManager: No valid cache found for ${userId}, generating fresh profile`);
            const freshProfile = await generateProfileFunction(userId);
            
            // Cache the fresh profile
            await this.cacheUserProfile(userId, freshProfile);
            
            return freshProfile;

        } catch (error) {
            logger.error(`PreferenceCacheManager: Error getting cached preferences for ${userId}:`, error);
            
            // Fallback: attempt to generate fresh profile
            try {
                return await generateProfileFunction(userId);
            } catch (fallbackError) {
                logger.error(`PreferenceCacheManager: Fallback profile generation failed for ${userId}:`, fallbackError);
                return this.getEmptyProfile(userId);
            }
        }
    }

    /**
     * Retrieves valid cached profile if exists
     * @param {string} userId - User identifier
     * @returns {Promise<object|null>} Cached profile or null if invalid/missing
     */
    async getValidCachedProfile(userId) {
        try {
            const cacheDoc = await firestoreHelper.getDocument(this.CACHE_COLLECTION, userId);
            
            if (!cacheDoc || !cacheDoc.cacheMetadata) {
                return null;
            }

            // Check if cache is still valid
            const cacheAgeHours = this.getCacheAgeHours(cacheDoc.cacheMetadata);
            if (cacheAgeHours > this.CACHE_TTL_HOURS) {
                logger.info(`PreferenceCacheManager: Cache expired for ${userId} (age: ${cacheAgeHours}h)`);
                return null;
            }

            // Check if cache was invalidated
            if (await this.isCacheInvalidated(userId, cacheDoc.cacheMetadata.lastUpdated)) {
                logger.info(`PreferenceCacheManager: Cache invalidated for ${userId} due to recent activity`);
                return null;
            }

            return cacheDoc;

        } catch (error) {
            logger.warn(`PreferenceCacheManager: Error checking cached profile for ${userId}:`, error);
            return null;
        }
    }

    /**
     * Caches user preference profile
     * @param {string} userId - User identifier
     * @param {object} profile - User preference profile
     */
    async cacheUserProfile(userId, profile) {
        try {
            const cacheData = {
                profile,
                cacheMetadata: {
                    lastUpdated: Date.now(),
                    generatedAt: profile.generatedAt || Date.now(),
                    profileVersion: '1.0',
                    dataQuality: profile.dataQuality || {}
                }
            };

            await firestoreHelper.saveDocument(this.CACHE_COLLECTION, userId, cacheData, { merge: true });
            logger.info(`PreferenceCacheManager: Cached profile for ${userId}`);

        } catch (error) {
            logger.error(`PreferenceCacheManager: Error caching profile for ${userId}:`, error);
        }
    }

    /**
     * Invalidates cache when user activity triggers it
     * @param {string} userId - User identifier
     * @param {string} eventType - Type of invalidation event
     */
    async invalidateUserCache(userId, eventType) {
        if (!this.INVALIDATION_EVENTS.includes(eventType)) {
            return;
        }

        try {
            // Mark cache as invalidated rather than deleting
            const updateData = {
                'cacheMetadata.invalidatedAt': Date.now(),
                'cacheMetadata.invalidatedBy': eventType
            };

            await firestoreHelper.saveDocument(this.CACHE_COLLECTION, userId, updateData, { merge: true });

            logger.info(`PreferenceCacheManager: Invalidated cache for ${userId} due to ${eventType}`);

        } catch (error) {
            logger.warn(`PreferenceCacheManager: Error invalidating cache for ${userId}:`, error);
        }
    }

    /**
     * Checks if cache was invalidated by recent user activity
     * @param {string} userId - User identifier
     * @param {number} cacheTimestamp - When cache was last updated
     * @returns {Promise<boolean>} Whether cache is invalidated
     */
    async isCacheInvalidated(userId, cacheTimestamp) {
        try {
            // Check for recent activity that would invalidate cache
            const cutoffTime = cacheTimestamp;

            // Check for recent recipe saves
            const recentSaves = await firestoreHelper.getCollection(`users/${userId}/my_recipes`, {
                where: [{ field: "createdAt", operator: ">", value: new Date(cutoffTime) }],
                limit: 1
            });

            if (recentSaves && recentSaves.length > 0) {
                return true;
            }

            // Check for recent cook logs
            const recentCooks = await firestoreHelper.getCollection(`users/${userId}/cook_log`, {
                where: [{ field: "timestamp", operator: ">", value: new Date(cutoffTime) }],
                limit: 1
            });

            if (recentCooks && recentCooks.length > 0) {
                return true;
            }

            return false;

        } catch (error) {
            logger.warn(`PreferenceCacheManager: Error checking cache invalidation for ${userId}:`, error);
            return false; // Conservative: don't invalidate on error
        }
    }

    /**
     * Triggers background profile update (fire-and-forget)
     * @param {string} userId - User identifier
     * @param {function} generateProfileFunction - Function to generate fresh profile
     */
    triggerBackgroundUpdate(userId, generateProfileFunction) {
        // Fire-and-forget background update
        setImmediate(async () => {
            try {
                logger.info(`PreferenceCacheManager: Starting background update for ${userId}`);
                const freshProfile = await generateProfileFunction(userId);
                await this.cacheUserProfile(userId, freshProfile);
                logger.info(`PreferenceCacheManager: Background update completed for ${userId}`);
            } catch (error) {
                logger.warn(`PreferenceCacheManager: Background update failed for ${userId}:`, error);
            }
        });
    }

    /**
     * Helper methods
     */

    getCacheAgeHours(cacheMetadata) {
        const ageMs = Date.now() - cacheMetadata.lastUpdated;
        return ageMs / (1000 * 60 * 60); // Convert to hours
    }

    shouldTriggerBackgroundUpdate(cacheMetadata) {
        return this.getCacheAgeHours(cacheMetadata) >= 18; // Trigger at 18+ hours
    }

    getEmptyProfile(userId) {
        return {
            userId,
            generatedAt: Date.now(),
            preferredIngredients: [],
            favoriteProteins: [],
            cuisineAffinities: [],
            cookingPatterns: { frequency: 'occasional', complexity: 'simple' },
            complexityPreference: 'simple',
            recentFavorites: [],
            seasonalPreferences: {},
            dataQuality: {
                cookbookSize: 0,
                recentActivity: 0,
                viewHistorySize: 0,
                hasGoodData: false
            }
        };
    }

    /**
     * Utility method to clean up old cache entries (can be called periodically)
     */
    async cleanupExpiredCache() {
        try {
            const cutoffTime = Date.now() - (this.CACHE_TTL_HOURS * 2 * 60 * 60 * 1000); // 48 hours ago
            
            const expiredEntries = await firestoreHelper.getCollection(this.CACHE_COLLECTION, {
                where: [{ field: "cacheMetadata.lastUpdated", operator: "<", value: cutoffTime }],
                limit: 50
            });

            for (const entry of expiredEntries || []) {
                await firestoreHelper.deleteDocument(this.CACHE_COLLECTION, entry.id);
            }

            if (expiredEntries && expiredEntries.length > 0) {
                logger.info(`PreferenceCacheManager: Cleaned up ${expiredEntries.length} expired cache entries`);
            }

        } catch (error) {
            logger.warn(`PreferenceCacheManager: Error during cache cleanup:`, error);
        }
    }
}

module.exports = UserPreferenceCacheManager; 