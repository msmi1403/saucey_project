const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2"); // Use Gen 2 logger
// Import the recipe parsing service
const { parseRecipeText } = require('../handleRecipeChatTurn/services/recipeParsingService');
const { getModel, generateContent } = require('../shared/services/geminiClient');
const globalConfig = require('../shared/config/globalConfig');
// Import cache manager for invalidating user preferences when rating recipes
const UserPreferenceCacheManager = require('../mealPlanFunctions/services/userPreferenceCacheManager');
// Assuming admin is initialized in a shared file, e.g., ../shared/firebaseAdmin.js
// If not, you might need:
// admin.initializeApp(); 
// For now, let's assume db is correctly sourced from an initialized admin instance.
// If your main `saucey-cloud-functions/index.js` or a shared setup file initializes admin,
// you can usually just use admin.firestore() directly.
// Let's try to get db from the shared admin instance if it's set up that way,
// otherwise, we might need to adjust how db is accessed.
// For now, assuming a global or appropriately scoped 'db' from admin.firestore().
// const db = admin.firestore(); // This would be typical if admin is initialized here or globally.

// To use the existing shared admin instance from ../shared/firebaseAdmin.js (if it exports 'db')
// const { db } = require('../shared/firebaseAdmin'); // Adjust path if necessary

// Let's assume for now that admin has been initialized in index.js or a shared module
// and admin.firestore() can be called.
// If you have a shared/firebaseAdmin.js that exports db:
// const { db } = require('../shared/admin'); // or similar path
// For this example, we'll define db directly for clarity if admin is globally initialized.
// However, the best practice is to get it from your shared admin initialization.

// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// Initialize cache manager for rating invalidation
const cacheManager = new UserPreferenceCacheManager();

/**
 * Unpublishes a public recipe by setting its isPublic flag to false and updating lastUpdated.
 * Requires authentication and ownership of the recipe.
 */
const unpublishPublicRecipe = onCall(async (request) => {
  const logPrefix = "unpublishPublicRecipe:"; // Added for logger

  // 1. Check authentication using request.auth
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`); // Changed to logger
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const recipeId = request.data.recipeId;

  // 2. Validate input
  if (!recipeId || typeof recipeId !== "string" || recipeId.length === 0) {
    logger.error(`${logPrefix} Invalid recipeId provided.`, { recipeId }); // Changed to logger
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with a valid 'recipeId' string."
    );
  }
  logger.info(`${logPrefix} User ${userId} attempting to unpublish recipe ${recipeId}.`); // Added for logger

  const publicRecipeRef = db.collection("public_recipes").doc(recipeId);

  try {
    const publicRecipeDoc = await publicRecipeRef.get();

    // 3. Check if the public recipe document exists
    if (!publicRecipeDoc.exists) {
      logger.info(
        `${logPrefix} Recipe ${recipeId} not found in public_recipes. No action needed.` // Changed to logger
      );
      return {
        success: true,
        message: "Recipe not found in public collection.",
      };
    }

    const recipeData = publicRecipeDoc.data();

    // 4. Verify ownership (Security Check)
    if (!recipeData.createdByUserId) {
      logger.error(
        `${logPrefix} Missing createdByUserId field on public recipe ${recipeId}. Cannot verify owner.` // Changed to logger
      );
      throw new HttpsError(
        "failed-precondition",
        "Recipe is missing creator information."
      );
    }

    if (recipeData.createdByUserId !== userId) {
      logger.error(
        `${logPrefix} User ${userId} attempted to unpublish recipe ${recipeId} owned by ${recipeData.createdByUserId}.` // Changed to logger
      );
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to unpublish this recipe."
      );
    }

    // 5. Perform the unpublish action (Set isPublic to false and update lastUpdated)
    const updateData = {
      isPublic: false,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(), // Added lastUpdated
    };
    await publicRecipeRef.update(updateData);
    logger.info(
      `${logPrefix} Successfully set isPublic=false and updated lastUpdated for recipe ${recipeId} in public_recipes by owner ${userId}.` // Changed to logger
    );
    return { success: true, message: "Recipe unpublished and marked as not public." }; // Updated message
  } catch (error) {
    logger.error(
      `${logPrefix} Error unpublishing recipe ${recipeId} from public_recipes:`, // Changed to logger
      error
    );
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError(
      "internal",
      "An error occurred while unpublishing the recipe.",
      error.message
    );
  }
});

/**
 * Shared helper function for recipe parsing with user context
 * Extracts common logic used by all parseRecipe* functions
 */
async function parseRecipeWithUserContext(recipeText, userId, logPrefix, existingRecipeId = null) {
  // 1. Validate input
  if (!recipeText || typeof recipeText !== "string" || recipeText.trim().length === 0) {
    logger.error(`${logPrefix} Invalid recipeText provided.`, { recipeText });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with valid 'recipeText' string."
    );
  }

  if (recipeText.length > 10000) {
    logger.error(`${logPrefix} Recipe text too long: ${recipeText.length} characters.`);
    throw new HttpsError(
      "invalid-argument", 
      "Recipe text is too long. Maximum 10,000 characters allowed."
    );
  }

  logger.info(`${logPrefix} User ${userId} parsing recipe text of ${recipeText.length} characters.`);
  if (existingRecipeId) {
    logger.info(`${logPrefix} Using existing recipe ID: ${existingRecipeId}`);
  }

  // 2. Get user preferences for context
  let userPreferences = null;
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      userPreferences = {
        difficulty: userData.preferredRecipeDifficulty || 'medium',
        allergensToAvoid: userData.allergensToAvoid || [],
        dietaryPreferences: userData.dietaryPreferences || [],
        customDietaryNotes: userData.customDietaryNotes || '',
        preferredCookTimePreference: userData.preferredCookTimePreference || '',
      };
    }
  } catch (prefError) {
    logger.warn(`${logPrefix} Could not fetch user preferences for ${userId}: ${prefError.message}`);
  }

  // 3. Parse the recipe text using the existing service with optional existing ID
  const parsedRecipe = await parseRecipeText(recipeText, userPreferences, existingRecipeId);

  return { parsedRecipe, userPreferences };
}

/**
 * Parse recipe and save to cookbook only (triggers recipe display view in app)
 */
const parseRecipeForCookbook = onCall(async (request) => {
  const logPrefix = "parseRecipeForCookbook:";

  // 1. Check authentication
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`);
    throw new HttpsError(
      "unauthenticated", 
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const { recipeText, existingRecipeId } = request.data;

  try {
    // 2. Use shared parsing logic with optional existing recipe ID
    const { parsedRecipe } = await parseRecipeWithUserContext(recipeText, userId, logPrefix, existingRecipeId);

    // 3. Save to my_recipes collection (will overwrite if existingRecipeId is provided)
    const recipeForSaving = {
      ...parsedRecipe,
      createdByUserId: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'generated_chat_saved',
      isPublic: false,
      isSecretRecipe: false
    };

    const myRecipesRef = db.collection('users').doc(userId).collection('my_recipes').doc(parsedRecipe.recipeId);
    await myRecipesRef.set(recipeForSaving);

    const action = existingRecipeId ? 'updated' : 'saved';
    logger.info(`${logPrefix} ${action} recipe to my_recipes: ${parsedRecipe.title} for user ${userId}`);

    return {
      success: true,
      recipe: parsedRecipe,
      message: `Recipe ${action} successfully`
    };

  } catch (error) {
    logger.error(`${logPrefix} Error processing recipe for user ${userId}:`, {
      error: error.message,
      stack: error.stack
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      "Failed to save recipe to cookbook. Please try again or check if the text contains a complete recipe.",
      error.message
    );
  }
});

/**
 * Parse recipe, save to my_recipes, and store user rating
 */
const parseRecipeAndRate = onCall(async (request) => {
  const logPrefix = "parseRecipeAndRate:";

  // 1. Check authentication
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`);
    throw new HttpsError(
      "unauthenticated", 
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const { recipeText, rating, chatTurnId } = request.data;

  // 2. Validate rating
  if (!rating || !["liked", "disliked"].includes(rating)) {
    logger.error(`${logPrefix} Invalid rating provided.`, { rating });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with rating 'liked' or 'disliked'."
    );
  }

  try {
    // 3. Use shared parsing logic
    const { parsedRecipe } = await parseRecipeWithUserContext(recipeText, userId, logPrefix);

    // 4. Save parsed recipe to my_recipes collection
    const recipeForSaving = {
      ...parsedRecipe,
      createdByUserId: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'generated_chat_rated',
      isPublic: false,
      isSecretRecipe: false
    };

    // 5. Prepare rating data
    const ratingData = {
      recipeId: parsedRecipe.recipeId,
      userId: userId,
      rating: rating, // "liked" or "disliked"
      ratedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "chat",
      recipeTitle: parsedRecipe.title,
      chatTurnId: chatTurnId || null // optional: specific chat context
    };

    // Batch save recipe and rating in parallel for better performance
    const myRecipesRef = db.collection('users').doc(userId).collection('my_recipes').doc(parsedRecipe.recipeId);
    const ratingRef = db.collection('users').doc(userId).collection('recipe_ratings').doc(parsedRecipe.recipeId);
    
    await Promise.all([
      myRecipesRef.set(recipeForSaving),
      ratingRef.set(ratingData)
    ]);

    // 6. Invalidate user preference cache to include new rating data
    try {
      await cacheManager.invalidateUserCache(userId, 'recipe_rated');
      logger.info(`${logPrefix} Invalidated user preference cache for ${userId} after rating`);
    } catch (cacheError) {
      logger.warn(`${logPrefix} Could not invalidate cache for ${userId}: ${cacheError.message}`);
      // Don't fail the entire operation if cache invalidation fails
    }

    logger.info(`${logPrefix} Saved recipe and rating (${rating}) for user ${userId}: ${parsedRecipe.title}`);

    return {
      success: true,
      recipe: parsedRecipe,
      rating: rating,
      message: `Recipe saved and rated as ${rating}`
    };

  } catch (error) {
    logger.error(`${logPrefix} Error processing recipe rating for user ${userId}:`, {
      error: error.message,
      stack: error.stack,
      rating: rating
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      "Failed to save recipe and rating. Please try again or check if the text contains a complete recipe.",
      error.message
    );
  }
});

/**
 * Unified function: Parses recipe and optionally adds ingredients to cart
 * REFACTORED to use shared parsing logic
 */
const parseRecipeAndManageCart = onCall(async (request) => {
  const logPrefix = "parseRecipeAndManageCart:";

  // 1. Check authentication
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`);
    throw new HttpsError(
      "unauthenticated", 
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const { recipeText, action } = request.data; // action: "save" | "add_to_cart"

  // 2. Validate action
  if (!action || !["save", "add_to_cart"].includes(action)) {
    logger.error(`${logPrefix} Invalid action provided.`, { action });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with action 'save' or 'add_to_cart'."
    );
  }

  try {
    // 3. Use shared parsing logic
    const { parsedRecipe } = await parseRecipeWithUserContext(recipeText, userId, logPrefix);

    // 4. Always save to my_recipes for user history
    const recipeForSaving = {
      ...parsedRecipe,
      createdByUserId: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'generated_chat_saved',
      isPublic: false,
      isSecretRecipe: false
    };

    // Save to my_recipes collection
    const myRecipesRef = db.collection('users').doc(userId).collection('my_recipes').doc(parsedRecipe.recipeId);
    await myRecipesRef.set(recipeForSaving);

    logger.info(`${logPrefix} Saved recipe to my_recipes: ${parsedRecipe.title} for user ${userId}`);

    let cartResult = null;

    // 5. If add_to_cart action, process ingredients with user context
    if (action === "add_to_cart") {
      try {
        // Get user's current ingredients for smart confidence analysis
        const userIngredients = await fetchUserIngredientsForAnalysis(userId);
        
        // Analyze ingredients with user context
        const ingredientsWithConfidence = await analyzeIngredientsWithUserContext(
          parsedRecipe.ingredients,
          userIngredients,
          parsedRecipe.title
        );

        // Add to grocery cart
        cartResult = await addIngredientsToCartWithConfidence(
          userId,
          ingredientsWithConfidence,
          {
            recipeId: parsedRecipe.recipeId,
            recipeTitle: parsedRecipe.title
          }
        );

        logger.info(`${logPrefix} Added ${cartResult.itemsAdded} ingredients to cart for user ${userId}`);

      } catch (cartError) {
        logger.error(`${logPrefix} Error adding ingredients to cart: ${cartError.message}`);
        // Don't fail the entire operation if cart addition fails
        cartResult = {
          success: false,
          error: cartError.message,
          itemsAdded: 0
        };
      }
    }

    return {
      success: true,
      recipe: parsedRecipe,
      action: action,
      cartResult: cartResult,
      message: action === "save" ? "Recipe saved successfully" : "Recipe saved and ingredients processed for cart"
    };

  } catch (error) {
    logger.error(`${logPrefix} Error processing recipe for user ${userId}:`, {
      error: error.message,
      stack: error.stack,
      action: action
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      "Failed to process recipe. Please try again or check if the text contains a complete recipe.",
      error.message
    );
  }
});

/**
 * Analyzes structured recipe and manages cart (no parsing step)
 * Reuses ingredient analysis and cart management logic from parseRecipeAndManageCart
 */
const analyzeRecipeAndManageCart = onCall(async (request) => {
  const logPrefix = "analyzeRecipeAndManageCart:";

  // 1. Check authentication
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`);
    throw new HttpsError(
      "unauthenticated", 
      "The function must be called while authenticated."
    );
  }

  const userId = request.auth.uid;
  const { recipe, action } = request.data;

  // 2. Validate input
  if (!recipe || typeof recipe !== "object") {
    logger.error(`${logPrefix} Invalid recipe object provided.`, { recipe });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with a valid 'recipe' object."
    );
  }

  if (!action || !["save", "add_to_cart"].includes(action)) {
    logger.error(`${logPrefix} Invalid action provided.`, { action });
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with action 'save' or 'add_to_cart'."
    );
  }

  if (!recipe.ingredients || !Array.isArray(recipe.ingredients)) {
    logger.error(`${logPrefix} Recipe missing ingredients array.`, { recipe });
    throw new HttpsError(
      "invalid-argument",
      "Recipe must contain a valid ingredients array."
    );
  }

  logger.info(`${logPrefix} User ${userId} analyzing structured recipe (action: ${action}): ${recipe.title}`);

  try {
    let cartResult = null;

    // Process ingredients with user context if add_to_cart action
    if (action === "add_to_cart") {
      try {
        // Get user's current ingredients for smart confidence analysis
        const userIngredients = await fetchUserIngredientsForAnalysis(userId);
        
        // Analyze ingredients with user context
        const ingredientsWithConfidence = await analyzeIngredientsWithUserContext(
          recipe.ingredients,
          userIngredients,
          recipe.title
        );

        // Add to grocery cart
        cartResult = await addIngredientsToCartWithConfidence(
          userId,
          ingredientsWithConfidence,
          {
            recipeId: recipe.recipeId,
            recipeTitle: recipe.title
          }
        );

        logger.info(`${logPrefix} Added ${cartResult.itemsAdded} ingredients to cart for user ${userId}`);

      } catch (cartError) {
        logger.error(`${logPrefix} Error adding ingredients to cart: ${cartError.message}`);
        cartResult = {
          success: false,
          error: cartError.message,
          itemsAdded: 0
        };
      }
    }

    return {
      success: true,
      recipe: recipe,
      action: action,
      cartResult: cartResult,
      message: action === "save" ? "Recipe analyzed successfully" : "Recipe analyzed and ingredients processed for cart"
    };

  } catch (error) {
    logger.error(`${logPrefix} Error processing structured recipe for user ${userId}:`, {
      error: error.message,
      stack: error.stack,
      recipeTitle: recipe.title,
      action: action
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      "Failed to analyze recipe. Please try again.",
      error.message
    );
  }
});

/**
 * Fetches user ingredients for smart confidence analysis
 */
async function fetchUserIngredientsForAnalysis(userId) {
  try {
    const ingredientsRef = db.collection('users').doc(userId).collection('ingredients');
    const snapshot = await ingredientsRef.where('isActive', '==', true).get();
    
    if (snapshot.empty) {
      logger.info(`fetchUserIngredientsForAnalysis: No active ingredients found for user ${userId}`);
      return [];
    }

    const ingredients = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      ingredients.push({
        name: data.name,
        kitchenSection: data.kitchenSection,
        location: data.location,
        isAvailable: data.isAvailable,
        quantity: data.quantity,
        confidence: data.confidence
      });
    });

    logger.info(`fetchUserIngredientsForAnalysis: Found ${ingredients.length} active ingredients for user ${userId}`);
    return ingredients;

  } catch (error) {
    logger.error(`fetchUserIngredientsForAnalysis: Error fetching ingredients for user ${userId}:`, error);
    return []; // Return empty array on error to allow operation to continue
  }
}

/**
 * Analyzes recipe ingredients and adds ALL to cart with user notes
 */
async function analyzeIngredientsWithUserContext(recipeIngredients, userIngredients, recipeTitle) {
  try {
    // Format user ingredients for analysis
    const userIngredientsText = userIngredients.length > 0 
      ? userIngredients.map(ing => `${ing.name} (${ing.kitchenSection || ing.location})`).join(', ')
      : 'No ingredients currently tracked in user\'s kitchen';

    // Format recipe ingredients
    const recipeIngredientsText = recipeIngredients.map(ing => 
      `${ing.item_name}${ing.quantity ? ` (${ing.quantity} ${ing.unit || ''})` : ''}`
    ).join(', ');

    const prompt = `
You are a grocery shopping assistant. Add ALL recipe ingredients to the user's grocery cart with appropriate store sections.

**USER'S KITCHEN INVENTORY**:
${userIngredientsText}

**RECIPE**: ${recipeTitle}
**INGREDIENTS**: ${recipeIngredientsText}

**YOUR TASK**:
1. Add EVERY ingredient to the grocery cart
2. Assign appropriate store section for each
3. For ingredients the user likely already has, add a brief note

**STORE SECTIONS** (use exactly these):
- "produce": fruits, vegetables, fresh herbs
- "meat": proteins, seafood  
- "dairy": milk, cheese, eggs, yogurt
- "pantry": oils, vinegars, spices, canned goods, grains, flour, sugar
- "bakery": bread, pastries
- "frozen": frozen items
- "beverages": drinks
- "household": non-food items
- "other": everything else

**OUTPUT FORMAT** (JSON only):
{
  "cartItems": [
    {
      "itemName": "chicken breast",
      "quantity": 1,
      "unit": "lb", 
      "storeSection": "meat",
      "userNote": null
    },
    {
      "itemName": "olive oil",
      "quantity": 2,
      "unit": "tbsp",
      "storeSection": "pantry", 
      "userNote": "We might already have this"
    }
  ]
}

**GUIDELINES**:
- Add ALL ingredients, no exceptions
- Only add userNote if you're confident user likely has the item based on their kitchen inventory
- Keep notes brief and collaborative: "We might already have this" or "Let's check our pantry first"
- Base notes on the user's actual kitchen inventory when provided
- Assign store sections that match grocery store layout

Only return the JSON object, no additional text.`;

    // Use the correct generateContent function from geminiClient
    const result = await generateContent({
      modelName: globalConfig.GEMINI_MODEL_NAME,
      contents: [{ text: prompt }],
      generationConfig: {
        temperature: globalConfig.GEMINI_TEXT_TEMPERATURE,
        maxOutputTokens: globalConfig.GEMINI_TEXT_MAX_OUTPUT_TOKENS,
      }
    });

    const responseText = result.text();

    // Parse JSON response
    let parsedResponse;
    try {
      let cleanedText = responseText.trim();
      
      // Remove markdown code blocks if present
      if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/```json\n?/, '').replace(/```$/, '');
      }
      
      // Try to find JSON in the response
      const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanedText = jsonMatch[0];
      }
      
      parsedResponse = JSON.parse(cleanedText);
    } catch (parseError) {
      logger.error('Error parsing cart analysis response:', parseError);
      // Fallback: return all ingredients with basic categorization and handle undefined values
      return recipeIngredients.map(ing => ({
        itemName: ing.item_name || 'Unknown ingredient',
        quantity: ing.quantity || null,
        unit: ing.unit || null, // Ensure unit is null instead of undefined
        storeSection: 'other',
        userNote: null
      }));
    }

    return parsedResponse.cartItems || [];

  } catch (error) {
    logger.error('Error in cart analysis with user context:', error);
    // Fallback: return all ingredients with basic categorization and handle undefined values
    return recipeIngredients.map(ing => ({
      itemName: ing.item_name || 'Unknown ingredient',
      quantity: ing.quantity || null,
      unit: ing.unit || null, // Ensure unit is null instead of undefined
      storeSection: 'other', 
      userNote: null
    }));
  }
}

/**
 * Adds ALL analyzed ingredients to cart with optional user notes
 */
async function addIngredientsToCartWithConfidence(userId, analyzedIngredients, recipeContext) {
  try {
    // Load user's current grocery cart
    const userCartRef = db.collection('users').doc(userId).collection('groceryCart').doc('currentCart');
    const cartDoc = await userCartRef.get();
    
    let currentCart = {
      items: [],
      isShared: false,
      sharedWith: [],
      sharedBy: null,
      shareCode: null,
      lastModified: new Date(),
      lastModifiedBy: userId
    };

    if (cartDoc.exists) {
      currentCart = cartDoc.data();
    }

    // Convert ALL analyzed ingredients to GroceryCartItem format (no filtering)
    const newCartItems = analyzedIngredients.map(ingredient => ({
      id: generateUUID(),
      itemName: ingredient.itemName || 'Unknown ingredient',
      quantity: parseQuantityToNumber(ingredient.quantity),
      unit: ingredient.unit || null, // Ensure unit is null instead of undefined
      isChecked: false,
      storeSection: mapToStoreAisle(ingredient.storeSection),
      originalRecipeId: recipeContext.recipeId,
      originalRecipeTitle: recipeContext.recipeTitle,
      sourceIngredientId: null,
      isManuallyAdded: false,
      addedAt: new Date(),
      lastModifiedBy: userId,
      syncVersion: 1,
      // Add user note if provided
      userLikelyHas: !!ingredient.userNote,
      confidenceScore: ingredient.userNote ? 0.9 : 0.5,
      confidenceReasoning: ingredient.userNote || 'Added from recipe',
      // NEW: Dismissal properties for "Already Have It" feature
      dismissedAsAlreadyHave: false,
      dismissedAt: null
    }));

    // Add new items to cart (avoid duplicates)
    const existingItemNames = new Set(
      currentCart.items.map(item => item.itemName.toLowerCase().trim())
    );

    const uniqueNewItems = newCartItems.filter(newItem => 
      !existingItemNames.has(newItem.itemName.toLowerCase().trim())
    );

    // Update cart with new items
    currentCart.items = [...currentCart.items, ...uniqueNewItems];
    currentCart.lastModified = new Date();
    currentCart.lastModifiedBy = userId;

    // Save updated cart to Firestore
    await userCartRef.set(currentCart);

    // Handle shared cart updates
    if (currentCart.isShared) {
      const allUsers = currentCart.sharedWith.concat(currentCart.sharedBy ? [currentCart.sharedBy] : []);
      
      for (const sharedUserId of allUsers) {
        if (sharedUserId !== userId) {
          const sharedUserCartRef = db.collection('users').doc(sharedUserId).collection('groceryCart').doc('currentCart');
          await sharedUserCartRef.set(currentCart);
        }
      }
    }

    const itemsWithNotes = uniqueNewItems.filter(item => item.userLikelyHas).length;

    return {
      success: true,
      itemsAdded: uniqueNewItems.length,
      totalItemsAnalyzed: analyzedIngredients.length,
      duplicatesSkipped: newCartItems.length - uniqueNewItems.length,
      itemsWithNotes: itemsWithNotes,
      hasHighConfidenceItems: itemsWithNotes > 0,
      message: `Added ${uniqueNewItems.length} ingredients to your grocery cart${itemsWithNotes > 0 ? ` (${itemsWithNotes} items you might already have)` : ''}`
    };

  } catch (error) {
    logger.error('Error adding ingredients to cart:', error);
    throw error;
  }
}

/**
 * Parse quantity string to number for iOS compatibility
 * Examples: "2 lbs" -> 2, "1.5" -> 1.5, "some" -> null
 */
function parseQuantityToNumber(quantityString) {
  if (!quantityString || typeof quantityString !== 'string') {
    return null;
  }
  
  // Extract first number from string (handles cases like "2 lbs", "1.5 cups", etc)
  const match = quantityString.match(/^(\d+(?:\.\d+)?)/);
  if (match) {
    const num = parseFloat(match[1]);
    return isNaN(num) ? null : num;
  }
  
  return null;
}

/**
 * Generate UUID for cart items (format compatible with iOS UUID)
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  }).toUpperCase();
}

/**
 * Map store section to iOS StoreAisle enum rawValue
 */
function mapToStoreAisle(section) {
  if (!section) return 'Miscellaneous';
  
  const sectionMap = {
    'produce': 'Produce',
    'meat': 'Meat & Seafood',
    'meat_seafood': 'Meat & Seafood', 
    'dairy': 'Dairy & Eggs',
    'dairy_eggs': 'Dairy & Eggs',
    'pantry': 'Pantry & Spices',
    'pantry_canned': 'Pantry & Spices',
    'spices': 'Pantry & Spices',
    'frozen': 'Frozen Foods',
    'frozen_foods': 'Frozen Foods',
    'bakery': 'Bakery',
    'beverages': 'Beverages',
    'condiments_sauces': 'Pantry & Spices',
    'sauces': 'Pantry & Spices',
    'household': 'Household & Other',
    'other': 'Miscellaneous',
    'miscellaneous': 'Miscellaneous'
  };
  
  return sectionMap[section.toLowerCase()] || 'Miscellaneous';
}

/**
 * Clears cart items from Firestore
 */
const clearGroceryCart = onCall(async (request) => {
  const logPrefix = "clearGroceryCart:";
  
  try {
    const { auth, data } = request;
    
    if (!auth) {
      logger.warn(`${logPrefix} Unauthenticated request`);
      throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = auth.uid;
    const { recipeId, clearAll = false } = data || {};
    
    logger.info(`${logPrefix} Request from user ${userId}. RecipeId: ${recipeId}, ClearAll: ${clearAll}`);

    // Load user's current grocery cart
    const userCartRef = db.collection('users').doc(userId).collection('groceryCart').doc('currentCart');
    const cartDoc = await userCartRef.get();
    
    if (!cartDoc.exists) {
      logger.info(`${logPrefix} No cart exists for user ${userId}`);
      return {
        success: true,
        itemsRemoved: 0,
        message: 'Cart was already empty'
      };
    }

    let currentCart = cartDoc.data();
    const originalItemCount = currentCart.items ? currentCart.items.length : 0;
    
    if (clearAll) {
      // Clear all items
      currentCart.items = [];
    } else if (recipeId) {
      // Clear items for specific recipe
      currentCart.items = currentCart.items.filter(item => item.originalRecipeId !== recipeId);
    } else {
      throw new HttpsError('invalid-argument', 'Must specify either recipeId or clearAll=true');
    }

    const itemsRemoved = originalItemCount - currentCart.items.length;
    currentCart.lastModified = new Date();
    currentCart.lastModifiedBy = userId;

    // Save updated cart to Firestore
    await userCartRef.set(currentCart);

    // Handle shared cart updates
    if (currentCart.isShared) {
      const allUsers = currentCart.sharedWith.concat(currentCart.sharedBy ? [currentCart.sharedBy] : []);
      
      for (const sharedUserId of allUsers) {
        if (sharedUserId !== userId) {
          const sharedUserCartRef = db.collection('users').doc(sharedUserId).collection('groceryCart').doc('currentCart');
          await sharedUserCartRef.set(currentCart);
        }
      }
    }

    logger.info(`${logPrefix} Cleared ${itemsRemoved} items from cart for user ${userId}`);

    return {
      success: true,
      itemsRemoved: itemsRemoved,
      message: clearAll 
        ? `Cleared all ${itemsRemoved} items from cart`
        : `Cleared ${itemsRemoved} items from recipe "${recipeId}"`
    };

  } catch (error) {
    logger.error(`${logPrefix} Error: ${error.message}`);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError('internal', 'Failed to clear grocery cart');
  }
});

module.exports = {
    unpublishPublicRecipe,
    parseRecipeForCookbook,
    parseRecipeAndManageCart,
    parseRecipeAndRate,
    analyzeRecipeAndManageCart,
    clearGroceryCart,
}; 