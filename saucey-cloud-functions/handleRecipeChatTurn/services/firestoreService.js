// saucey-cloud-functions/handleRecipeChatTurn/services/firestoreService.js


const firestoreHelper = require('@saucey/shared/services/firestoreHelper.js'); 
const { generateUniqueId } = require('@saucey/shared/utils/commonUtils.js'); 

const config = require('../config'); // Uses its own function's config for collection names

/**
 * Saves or updates a recipe in the user's recipe subcollection in Firestore.
 * @param {string} userId - The ID of the user.
 * @param {object} recipeData - The recipe object to save. Must include recipeId.
 * @returns {Promise<string>} The recipeId of the saved/updated recipe.
 * @throws {Error} If saving fails.
 */
async function saveOrUpdateUserRecipe(userId, recipeData) {
    if (!userId) throw new Error('User ID is required to save a recipe.');
    if (!recipeData || typeof recipeData !== 'object') throw new Error('Valid recipe data is required.');

    let currentRecipeId = recipeData.recipeId;
    if (!currentRecipeId) {
        console.warn('recipeData missing recipeId for saveOrUpdateUserRecipe, generating a new one.');
        currentRecipeId = generateUniqueId();
        recipeData.recipeId = currentRecipeId; // Ensure recipeData object has the ID
    }

    const collectionPath = `${config.USERS_COLLECTION}/${userId}/${config.RECIPES_SUBCOLLECTION}`;
    console.log(`Attempting to save/update recipe ${currentRecipeId} for user ${userId} in ${collectionPath}.`);

    // The helper's saveDocument handles timestamps by default if addTimestamps is true (default)
    // It also handles createdAt for new documents and updatedAt for all.
    return firestoreHelper.saveDocument(collectionPath, currentRecipeId, recipeData, { merge: true, addTimestamps: true });
}

/**
 * Fetches a specific recipe for a user from Firestore.
 * @param {string} userId - The ID of the user.
 * @param {string} recipeId - The ID of the recipe to fetch.
 * @returns {Promise<object|null>} The recipe object if found, otherwise null.
 */
async function getUserRecipe(userId, recipeId) {
    if (!userId || !recipeId) throw new Error('User ID and Recipe ID are required for getUserRecipe.');
    const collectionPath = `${config.USERS_COLLECTION}/${userId}/${config.RECIPES_SUBCOLLECTION}`;
    return firestoreHelper.getDocument(collectionPath, recipeId);
}

/**
 * Fetches user preferences (dietary info) from their user document.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<object|null>} User preferences object or null if not found/applicable.
 */
async function getUserPreferences(userId) {
    if (!userId) {
        console.warn("getUserPreferences called without userId.");
        return null;
    }
    try {
        const userDoc = await firestoreHelper.getDocument(config.USERS_COLLECTION, userId);
        if (!userDoc) {
            console.log(`User document not found for preferences: ${userId}`);
            return null;
        }
        // Assuming preferences are stored directly on the user document
        const preferences = {
            selected_filters: userDoc.selectedDietaryFilters || [],
            custom_notes: userDoc.customDietaryNotes || null,
        };
        console.log(`Workspaceed preferences for user ${userId}.`);
        return preferences;
    } catch (error) {
        console.error(`Error fetching preferences for user ${userId}:`, error);
        // Don't throw critical error for this, as it's supplementary
        return null;
    }
}

/**
 * Saves a chat message to a specific chat session for a user.
 * @param {string} userId - The ID of the user.
 * @param {string} chatId - The ID of the chat session.
 * @param {object} messageData - Object containing { role, parts, timestamp? }.
 */
async function saveChatMessage(userId, chatId, messageData) {
    if (!userId || !chatId || !messageData || !messageData.role || !Array.isArray(messageData.parts)) {
        console.error('saveChatMessage: Missing required parameters or invalid messageData structure.', { userId, chatId });
        throw new Error('UserId, ChatId, role, and parts are required to save chat message.');
    }
    const collectionPath = `${config.USERS_COLLECTION}/${userId}/chats/${chatId}/messages`;

    // Ensure timestamp is FieldValue.serverTimestamp() if not already provided as such
    const dataToSave = {
        ...messageData,
        timestamp: messageData.timestamp && messageData.timestamp.constructor.name === 'ServerTimestampFieldValue'
            ? messageData.timestamp
            : firestoreHelper.FieldValue.serverTimestamp()
    };
    // addDocument in helper will auto-gen ID.
    // The helper's addDocument addTimestamps default is true, which would add its own createdAt/updatedAt.
    // If messageData already has a specific `timestamp` you want to preserve as the primary one,
    // and you don't want the helper to add its own `createdAt`/`updatedAt` for the message document itself,
    // you might pass { addTimestamps: false } or ensure the dataToSave structure is what you intend.
    // For chat messages, a single 'timestamp' field is common.
    return firestoreHelper.addDocument(collectionPath, dataToSave, { addTimestamps: false });
}

/**
 * Retrieves the last N messages for a given chat session, ordered chronologically.
 * @param {string} userId - The ID of the user.
 * @param {string} chatId - The ID of the chat session.
 * @param {number} limit - The maximum number of messages to retrieve.
 * @returns {Promise<Array<object>>} Array of message objects.
 */
async function getChatHistory(userId, chatId, limit = 10) {
    if (!userId || !chatId) {
        throw new Error('UserId and ChatId are required to get chat history.');
    }
    const collectionPath = `${config.USERS_COLLECTION}/${userId}/chats/${chatId}/messages`;
    try {
        const history = await firestoreHelper.getCollection(collectionPath, {
            orderBy: [{ field: 'timestamp', direction: 'desc' }],
            limit: limit
        });
        // Messages are fetched newest first, so reverse to get chronological order for the prompt.
        return history.reverse();
    } catch (error) {
        console.error(`Error fetching chat history for chat ${chatId}, user ${userId} via helper:`, error);
        throw new Error(`Firestore get chat history failed: ${error.message}`);
    }
}

module.exports = {
    saveOrUpdateUserRecipe,
    getUserRecipe,
    getUserPreferences,
    saveChatMessage,
    getChatHistory,
};