const { logger } = require("firebase-functions/v2");
const firestoreHelper = require('./firestoreHelper');

class ChatSessionManager {
    constructor() {
        // In-memory cache for chat sessions
        this.chatCache = new Map();
        this.CACHE_TTL = 60 * 60 * 1000; // 1 hour
    }

    /**
     * Get or create chat session with cached user preferences
     */
    async getChatSession(userId, chatId, preferredChefPersonalityKey) {
        const cacheKey = `${userId}_${chatId}`;
        
        // Check if we have valid cached session
        if (this.chatCache.has(cacheKey)) {
            const cached = this.chatCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.CACHE_TTL) {
                logger.info(`Using cached session for chat ${chatId}`, { userId, chatId });
                return cached.data;
            } else {
                // Expired cache
                this.chatCache.delete(cacheKey);
            }
        }

        // Fetch fresh session data
        logger.info(`Creating new session cache for chat ${chatId}`, { userId, chatId });
        
        try {
            // Fetch user preferences
            const userPreferences = await this.fetchUserPreferences(userId);
            
            // Get chef personality
            const chefPersonality = this.getChefPersonality(preferredChefPersonalityKey);
            
            const sessionData = {
                userPreferences,
                chefPersonality,
                sessionStartTime: new Date().toISOString(),
                chatId,
                userId
            };

            // Cache the session data
            this.chatCache.set(cacheKey, {
                data: sessionData,
                timestamp: Date.now()
            });

            return sessionData;
        } catch (error) {
            logger.error(`Failed to create chat session for ${chatId}:`, { error: error.message, userId, chatId });
            
            // Return minimal session data as fallback
            return {
                userPreferences: { difficulty: 'medium' },
                chefPersonality: this.getChefPersonality(preferredChefPersonalityKey),
                sessionStartTime: new Date().toISOString(),
                chatId,
                userId
            };
        }
    }

    /**
     * Fetch user preferences from Firestore
     */
    async fetchUserPreferences(userId) {
        try {
            const userDoc = await firestoreHelper.getDocument('users', userId);
            
            if (userDoc && userDoc.exists) {
                const userData = userDoc.data();
                return {
                    difficulty: userData.difficulty || 'medium',
                    dietaryRestrictions: userData.dietaryRestrictions || [],
                    cuisinePreferences: userData.cuisinePreferences || [],
                    allergies: userData.allergies || [],
                    servingSize: userData.servingSize || 4
                };
            }
            
            // Default preferences if no user data
            return {
                difficulty: 'medium',
                dietaryRestrictions: [],
                cuisinePreferences: [],
                allergies: [],
                servingSize: 4
            };
        } catch (error) {
            logger.warn(`Could not fetch user preferences for ${userId}:`, { error: error.message });
            return {
                difficulty: 'medium',
                dietaryRestrictions: [],
                cuisinePreferences: [],
                allergies: [],
                servingSize: 4
            };
        }
    }

    /**
     * Get chef personality configuration
     */
    getChefPersonality(personalityKey = 'default') {
        const personalities = {
            'default': {
                systemPrompt: 'You are a helpful cooking assistant.',
                persona: 'Friendly and knowledgeable',
                speakingStyle: 'Clear and encouraging'
            },
            'Helpful Chef': {
                systemPrompt: 'You are a helpful, encouraging chef who loves to share cooking tips and make cooking accessible for everyone.',
                persona: 'Warm, encouraging, and patient',
                speakingStyle: 'Conversational and supportive, uses cooking terms naturally'
            },
            'Gordon Ramsay': {
                systemPrompt: 'You are an intense, passionate chef who demands excellence but is deeply knowledgeable.',
                persona: 'Direct, passionate, high standards',
                speakingStyle: 'Blunt but educational, uses British expressions'
            },
            'Julia Child': {
                systemPrompt: 'You are a gentle, educational chef who makes complex cooking techniques approachable.',
                persona: 'Patient, educational, and encouraging',
                speakingStyle: 'Detailed explanations with a warm, teaching tone'
            }
        };

        return personalities[personalityKey] || personalities['default'];
    }

    /**
     * Get active recipe cards for a chat
     */
    async getActiveRecipeCards(userId, chatId) {
        try {
            const cardsSnapshot = await firestoreHelper.getCollection(`users/${userId}/chats/${chatId}/recipeCards`);
            
            if (!cardsSnapshot || cardsSnapshot.empty) {
                return [];
            }

            const cards = [];
            cardsSnapshot.forEach(doc => {
                const cardData = doc.data();
                // Filter out expired cards (older than 30 minutes of inactivity)
                const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
                if (cardData.lastMentioned && cardData.lastMentioned.toMillis() > thirtyMinutesAgo) {
                    cards.push({
                        id: doc.id,
                        ...cardData
                    });
                }
            });

            return cards;
        } catch (error) {
            logger.warn(`Could not fetch recipe cards for chat ${chatId}:`, { error: error.message, userId, chatId });
            return [];
        }
    }

    /**
     * Save or update recipe card
     */
    async saveRecipeCard(userId, chatId, recipeCard) {
        try {
            const cardData = {
                ...recipeCard,
                lastMentioned: new Date(),
                updatedAt: new Date()
            };

            await firestoreHelper.setDocument(`users/${userId}/chats/${chatId}/recipeCards`, recipeCard.id, cardData);
            logger.info(`Saved recipe card ${recipeCard.id} for chat ${chatId}`, { userId, chatId });
        } catch (error) {
            logger.warn(`Failed to save recipe card for chat ${chatId}:`, { error: error.message, userId, chatId });
        }
    }

    /**
     * Clear chat session cache (for testing or explicit cache invalidation)
     */
    clearChatSession(userId, chatId) {
        const cacheKey = `${userId}_${chatId}`;
        this.chatCache.delete(cacheKey);
        logger.info(`Cleared cache for chat ${chatId}`, { userId, chatId });
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            totalSessions: this.chatCache.size,
            sessions: Array.from(this.chatCache.keys())
        };
    }
}

// Export singleton instance
const chatSessionManager = new ChatSessionManager();
module.exports = chatSessionManager; 