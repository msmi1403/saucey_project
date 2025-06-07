const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const UserPreferenceCacheManager = require('../../../mealPlanFunctions/services/userPreferenceCacheManager');

// Mock firestoreHelper
jest.mock('@saucey/shared/services/firestoreHelper', () => ({
    getDocument: jest.fn(),
    setDocument: jest.fn(),
    updateDocument: jest.fn(),
    deleteDocument: jest.fn(),
    getCollection: jest.fn()
}));

// Mock logger
jest.mock('firebase-functions/v2', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

const firestoreHelper = require('@saucey/shared/services/firestoreHelper');

describe('UserPreferenceCacheManager', () => {
    let cacheManager;
    const mockUserId = 'test-user-123';
    const mockProfile = {
        userId: mockUserId,
        generatedAt: Date.now(),
        cuisineAffinities: [{ cuisine: 'Italian', score: 8.5 }],
        favoriteProteins: [{ protein: 'chicken', score: 9.0 }],
        dataQuality: { hasGoodData: true }
    };

    beforeEach(() => {
        cacheManager = new UserPreferenceCacheManager();
        jest.clearAllMocks();
    });

    describe('getCachedUserPreferences', () => {
        test('should return cached profile when valid cache exists', async () => {
            const cachedData = {
                profile: mockProfile,
                cacheMetadata: {
                    lastUpdated: Date.now() - (10 * 60 * 60 * 1000), // 10 hours ago
                    generatedAt: mockProfile.generatedAt
                }
            };

            firestoreHelper.getDocument.mockResolvedValue(cachedData);
            firestoreHelper.getCollection.mockResolvedValue([]); // No recent activity

            const mockGenerateFunction = jest.fn();
            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toEqual(mockProfile);
            expect(mockGenerateFunction).not.toHaveBeenCalled();
            expect(firestoreHelper.getDocument).toHaveBeenCalledWith('user_preference_cache/test-user-123');
        });

        test('should generate fresh profile when no cache exists', async () => {
            firestoreHelper.getDocument.mockResolvedValue(null);
            const mockGenerateFunction = jest.fn().mockResolvedValue(mockProfile);

            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toEqual(mockProfile);
            expect(mockGenerateFunction).toHaveBeenCalledWith(mockUserId);
            expect(firestoreHelper.setDocument).toHaveBeenCalled();
        });

        test('should generate fresh profile when cache is expired', async () => {
            const expiredCache = {
                profile: mockProfile,
                cacheMetadata: {
                    lastUpdated: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago (expired)
                    generatedAt: mockProfile.generatedAt
                }
            };

            firestoreHelper.getDocument.mockResolvedValue(expiredCache);
            const mockGenerateFunction = jest.fn().mockResolvedValue(mockProfile);

            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toEqual(mockProfile);
            expect(mockGenerateFunction).toHaveBeenCalledWith(mockUserId);
        });

        test('should generate fresh profile when cache is invalidated by recent activity', async () => {
            const cachedData = {
                profile: mockProfile,
                cacheMetadata: {
                    lastUpdated: Date.now() - (5 * 60 * 60 * 1000), // 5 hours ago
                    generatedAt: mockProfile.generatedAt
                }
            };

            firestoreHelper.getDocument.mockResolvedValue(cachedData);
            // Mock recent activity that would invalidate cache
            firestoreHelper.getCollection
                .mockResolvedValueOnce([{ recipeId: 'new-recipe' }]) // Recent recipe save
                .mockResolvedValueOnce([]); // No recent cook logs

            const mockGenerateFunction = jest.fn().mockResolvedValue(mockProfile);

            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toEqual(mockProfile);
            expect(mockGenerateFunction).toHaveBeenCalledWith(mockUserId);
        });

        test('should handle errors gracefully and fallback to fresh generation', async () => {
            firestoreHelper.getDocument.mockRejectedValue(new Error('Firestore error'));
            const mockGenerateFunction = jest.fn().mockResolvedValue(mockProfile);

            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toEqual(mockProfile);
            expect(mockGenerateFunction).toHaveBeenCalledWith(mockUserId);
        });

        test('should return empty profile when both cache and generation fail', async () => {
            firestoreHelper.getDocument.mockRejectedValue(new Error('Firestore error'));
            const mockGenerateFunction = jest.fn().mockRejectedValue(new Error('Generation error'));

            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toHaveProperty('userId', mockUserId);
            expect(result).toHaveProperty('preferredIngredients', []);
            expect(result.dataQuality.hasGoodData).toBe(false);
        });
    });

    describe('cacheUserProfile', () => {
        test('should cache profile with proper metadata', async () => {
            await cacheManager.cacheUserProfile(mockUserId, mockProfile);

            expect(firestoreHelper.setDocument).toHaveBeenCalledWith(
                'user_preference_cache/test-user-123',
                expect.objectContaining({
                    profile: mockProfile,
                    cacheMetadata: expect.objectContaining({
                        lastUpdated: expect.any(Number),
                        generatedAt: mockProfile.generatedAt,
                        profileVersion: '1.0'
                    })
                })
            );
        });

        test('should handle caching errors gracefully', async () => {
            firestoreHelper.setDocument.mockRejectedValue(new Error('Firestore error'));

            // Should not throw
            await expect(cacheManager.cacheUserProfile(mockUserId, mockProfile))
                .resolves.not.toThrow();
        });
    });

    describe('invalidateUserCache', () => {
        test('should invalidate cache for valid events', async () => {
            await cacheManager.invalidateUserCache(mockUserId, 'recipe_saved');

            expect(firestoreHelper.updateDocument).toHaveBeenCalledWith(
                'user_preference_cache/test-user-123',
                expect.objectContaining({
                    'cacheMetadata.invalidatedAt': expect.any(Number),
                    'cacheMetadata.invalidatedBy': 'recipe_saved'
                })
            );
        });

        test('should ignore invalid events', async () => {
            await cacheManager.invalidateUserCache(mockUserId, 'invalid_event');

            expect(firestoreHelper.updateDocument).not.toHaveBeenCalled();
        });

        test('should handle invalidation errors gracefully', async () => {
            firestoreHelper.updateDocument.mockRejectedValue(new Error('Firestore error'));

            // Should not throw
            await expect(cacheManager.invalidateUserCache(mockUserId, 'recipe_saved'))
                .resolves.not.toThrow();
        });
    });

    describe('getCacheAgeHours', () => {
        test('should calculate cache age correctly', () => {
            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
            const metadata = { lastUpdated: twoHoursAgo };

            const age = cacheManager.getCacheAgeHours(metadata);

            expect(age).toBeCloseTo(2, 1); // Within 0.1 hours
        });
    });

    describe('shouldTriggerBackgroundUpdate', () => {
        test('should trigger update for stale cache', () => {
            const staleCache = { lastUpdated: Date.now() - (20 * 60 * 60 * 1000) }; // 20 hours ago

            const shouldUpdate = cacheManager.shouldTriggerBackgroundUpdate(staleCache);

            expect(shouldUpdate).toBe(true);
        });

        test('should not trigger update for fresh cache', () => {
            const freshCache = { lastUpdated: Date.now() - (10 * 60 * 60 * 1000) }; // 10 hours ago

            const shouldUpdate = cacheManager.shouldTriggerBackgroundUpdate(freshCache);

            expect(shouldUpdate).toBe(false);
        });
    });

    describe('cleanupExpiredCache', () => {
        test('should delete expired cache entries', async () => {
            const expiredEntries = [
                { userId: 'user1' },
                { userId: 'user2' }
            ];

            firestoreHelper.getCollection.mockResolvedValue(expiredEntries);

            await cacheManager.cleanupExpiredCache();

            expect(firestoreHelper.deleteDocument).toHaveBeenCalledWith('user_preference_cache/user1');
            expect(firestoreHelper.deleteDocument).toHaveBeenCalledWith('user_preference_cache/user2');
        });

        test('should handle cleanup errors gracefully', async () => {
            firestoreHelper.getCollection.mockRejectedValue(new Error('Firestore error'));

            // Should not throw
            await expect(cacheManager.cleanupExpiredCache()).resolves.not.toThrow();
        });
    });

    describe('background update behavior', () => {
        test('should trigger background update for stale cache', async () => {
            const staleCache = {
                profile: mockProfile,
                cacheMetadata: {
                    lastUpdated: Date.now() - (19 * 60 * 60 * 1000), // 19 hours ago (stale)
                    generatedAt: mockProfile.generatedAt
                }
            };

            firestoreHelper.getDocument.mockResolvedValue(staleCache);
            firestoreHelper.getCollection.mockResolvedValue([]); // No recent activity
            const mockGenerateFunction = jest.fn().mockResolvedValue(mockProfile);

            // Mock setImmediate to test background trigger
            const originalSetImmediate = global.setImmediate;
            global.setImmediate = jest.fn((callback) => callback());

            const result = await cacheManager.getCachedUserPreferences(mockUserId, mockGenerateFunction);

            expect(result).toEqual(mockProfile);
            expect(global.setImmediate).toHaveBeenCalled();

            // Restore original
            global.setImmediate = originalSetImmediate;
        });
    });
}); 