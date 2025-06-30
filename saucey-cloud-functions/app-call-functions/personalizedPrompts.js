const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const geminiClient = require("@saucey/shared/services/geminiClient");
const { UserPreferenceAnalyzer } = require("../shared/services/userPreferenceAnalyzer");
const UserPreferenceCacheManager = require("../mealPlanFunctions/services/userPreferenceCacheManager");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const config = require("../handleRecipeChatTurn/config"); // Import shared config for model consistency

/**
 * Generates personalized recipe prompt cards using Gemini AI
 * Based on user preferences, time context, and behavioral data
 */
const generatePersonalizedRecipePrompts = onCall(async (request) => {
  const logPrefix = "generatePersonalizedRecipePrompts:";
  
  if (!request.auth) {
    logger.error(`${logPrefix} Authentication required.`);
    throw new HttpsError("unauthenticated", "The function must be called while authenticated.");
  }
  
  const userId = request.auth.uid;
  const requestData = request.data || {};
  
  logger.info(`${logPrefix} Function started for user ${userId}`);

  try {
    // Build user context from multiple sources
    const userContext = await buildUserContext(userId, requestData);
    
    // Generate prompts using Gemini
    const prompts = await generatePromptsWithGemini(userContext);
    
    logger.info(`${logPrefix} Generated ${prompts.length} personalized prompts for user ${userId}`);
    
    return {
      success: true,
      prompts: prompts,
      generatedAt: new Date().toISOString(),
      context: userContext
    };

  } catch (error) {
    logger.error(`${logPrefix} Error for user ${userId}:`, error);
    
    // Return fallback prompts on error
    const fallbackPrompts = getFallbackPrompts(getCurrentTimeOfDay());
    return {
      success: true,
      prompts: fallbackPrompts,
      generatedAt: new Date().toISOString(),
      context: { fallback: true },
      fallbackReason: error.message
    };
  }
});

/**
 * Builds comprehensive user context from preferences and behavioral data
 */
async function buildUserContext(userId, requestData) {
  const userPreferenceAnalyzer = new UserPreferenceAnalyzer();
  const preferenceCache = new UserPreferenceCacheManager();
  
  // Get time context (allow override for testing)
  const timeOfDay = requestData.timeOfDay || getCurrentTimeOfDay();
  const isWeekend = requestData.isWeekend !== undefined ? requestData.isWeekend : isCurrentlyWeekend();
  
  // Fetch user preferences and behavioral data in parallel
  const [mealPlanPrefs, userProfile] = await Promise.all([
    fetchMealPlanPreferences(userId),
    preferenceCache.getCachedUserPreferences(
      userId, 
      userPreferenceAnalyzer.generateUserPreferenceProfile.bind(userPreferenceAnalyzer)
    )
  ]);
  
  // Build context object
  const context = {
    timeOfDay,
    isWeekend,
    // From meal plan preferences
    preferredCuisines: mealPlanPrefs?.preferredCuisines || [],
    dietaryPreferences: mealPlanPrefs?.dietaryPreferences?.map(pref => pref) || [],
    cookingExperience: mealPlanPrefs?.cookingExperience || 'intermediate',
    quickMeals: isQuickMealPreference(mealPlanPrefs),
    mealPrep: mealPlanPrefs?.prepVolume === 'batchPrep',
    healthFocused: isHealthFocused(mealPlanPrefs),
    // From behavioral analysis
    topIngredients: userProfile?.preferredIngredients?.slice(0, 6).map(i => i.ingredient) || [],
    favoriteProteins: userProfile?.favoriteProteins?.slice(0, 4).map(p => p.protein) || [],
    cuisineAffinities: userProfile?.cuisineAffinities?.slice(0, 4).map(c => c.cuisine) || [],
    cookingFrequency: userProfile?.cookingPatterns?.frequency || 'unknown',
    complexityPreference: userProfile?.complexityPreference || 'medium'
  };
  
  logger.info(`buildUserContext: Built context for ${userId} - time: ${timeOfDay}, cuisines: ${context.preferredCuisines.length}, behavioral: ${context.cuisineAffinities.length} affinities`);
  
  return context;
}

/**
 * Fetches user meal plan preferences
 */
async function fetchMealPlanPreferences(userId) {
  try {
    const prefsDoc = await firestoreHelper.getDocument(`users/${userId}/mealPlanPreferences`, 'current');
    return prefsDoc || null;
  } catch (error) {
    logger.warn(`fetchMealPlanPreferences: Error fetching preferences for ${userId}:`, error);
    return null;
  }
}

/**
 * Determines if user prefers quick meals
 */
function isQuickMealPreference(prefs) {
  if (!prefs?.cookTimePreference) return false;
  return ['fifteenMinutes', 'thirtyMinutes'].includes(prefs.cookTimePreference);
}

/**
 * Determines if user is health-focused
 */
function isHealthFocused(prefs) {
  if (!prefs?.mealPlanObjectives) return false;
  return prefs.mealPlanObjectives.some(obj => 
    ['eatHealthier', 'loseWeight', 'buildMuscle'].includes(obj)
  );
}

/**
 * Generates personalized prompts using Gemini AI
 */
async function generatePromptsWithGemini(userContext) {
  const prompt = buildGeminiPrompt(userContext);
  
  try {
    const response = await geminiClient.generateContent({
      modelName: config.GEMINI_MODEL_NAME, // Use config model for consistency
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 1000,
        responseMimeType: "application/json"
      }
    });

    const responseText = response.text();
    const prompts = JSON.parse(responseText);
    
    // Validate response format
    if (!Array.isArray(prompts)) {
      throw new Error('Invalid response format: expected array');
    }
    
    // Ensure each prompt has required fields
    const validPrompts = prompts.filter(p => 
      p.title && p.prompt && p.icon && 
      p.title.length > 0 && p.title.length <= 25 &&
      p.prompt.length > 0 && p.prompt.length <= 100
    );
    
    return validPrompts.slice(0, 6); // Maximum 6 prompts
    
  } catch (error) {
    logger.error('generatePromptsWithGemini: Error calling Gemini:', error);
    throw new Error(`Failed to generate prompts: ${error.message}`);
  }
}



/**
 * Builds the specialized prompt for Gemini
 */
function buildGeminiPrompt(context) {
  const availableIcons = `
CUISINE ICONS: cuisine_italian, cuisine_mexican, cuisine_chinese, cuisine_japanese, cuisine_french, cuisine_thai, cuisine_indian, cuisine_korean, cuisine_vietnamese, cuisine_greek, cuisine_american, cuisine_mediterranean

FOOD ICONS: icon_croissant, icon_egg, icon_coffee, icon_bread, icon_salad, icon_burger, icon_bento, icon_noodles, icon_steak, icon_pasta, icon_fish, icon_seafood, icon_pizza, icon_sushi, icon_manysushi, icon_tacos, icon_dumpling, icon_cookie, icon_lemonade, icon_knife, icon_seasoning`;

  return `You are a smart recipe assistant creating personalized recipe prompt cards for a cooking app.

CURRENT CONTEXT:
- Time: ${context.timeOfDay} ${context.isWeekend ? '(weekend)' : '(weekday)'}
- Cooking experience: ${context.cookingExperience}
- Quick meals preference: ${context.quickMeals}
- Meal prep focused: ${context.mealPrep}
- Health focused: ${context.healthFocused}
- Cooking frequency: ${context.cookingFrequency}

USER PREFERENCES:
- Preferred cuisines: ${context.preferredCuisines.join(', ') || 'none specified'}
- Dietary needs: ${context.dietaryPreferences.join(', ') || 'none'}
- Liked ingredients: ${context.topIngredients.join(', ') || 'none'}
- Favorite proteins: ${context.favoriteProteins.join(', ') || 'none'}
- Cuisine affinities: ${context.cuisineAffinities.join(', ') || 'none'}

${availableIcons}

TASK: Generate exactly 5 personalized recipe prompt cards. Each should be:
- SHORT title (2-4 words max, under 25 characters)
- Contextually relevant to current time and user preferences
- Fun and engaging tone
- Concise prompt (under 15 words, max 100 characters)
- Include appropriate icon from available list

RULES:
- **PRIORITIZE time-appropriate meals**: Generate ${context.timeOfDay} meal types (breakfast for morning, lunch for afternoon, dinner for evening)
- Use user's preferred cuisines and ingredients when possible
- Match complexity to their experience level
- Keep language casual and inspiring
- Focus on what would be most helpful RIGHT NOW

OUTPUT FORMAT (valid JSON only):
[
  {
    "title": "Quick Breakfast",
    "prompt": "Give me 3 energizing breakfast recipes under 15 minutes",
    "icon": "icon_egg",
    "priority": 10
  },
  {
    "title": "Italian Comfort",
    "prompt": "Show me 3 cozy Italian recipes for tonight",
    "icon": "cuisine_italian", 
    "priority": 9
  }
]

Generate 5 prompts that feel personalized to this specific user's preferences and current context.`;
}

/**
 * Utility functions
 */
function getCurrentTimeOfDay() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 16) return 'afternoon';
  if (hour >= 16 && hour < 21) return 'evening';
  return 'night';
}

function isCurrentlyWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6; // Sunday or Saturday
}

/**
 * Fallback prompts when Gemini fails
 */
function getFallbackPrompts(timeOfDay) {
  const fallbackSets = {
    morning: [
      { title: "Quick Breakfast", prompt: "Give me 3 energizing breakfast recipes under 15 minutes", icon: "icon_egg", priority: 10 },
      { title: "Coffee Shop Vibes", prompt: "Show me 3 cafe-style breakfast recipes", icon: "icon_coffee", priority: 9 },
      { title: "Healthy Start", prompt: "Give me 3 nutritious breakfast ideas", icon: "icon_bread", priority: 8 }
    ],
    afternoon: [
      { title: "Light Lunch", prompt: "Show me 3 fresh lunch recipes for today", icon: "icon_salad", priority: 10 },
      { title: "Quick Bites", prompt: "Give me 3 satisfying lunch ideas under 30 minutes", icon: "icon_burger", priority: 9 },
      { title: "Asian Flavors", prompt: "Show me 3 delicious Asian lunch recipes", icon: "cuisine_chinese", priority: 8 }
    ],
    evening: [
      { title: "Cozy Dinner", prompt: "Give me 3 comforting dinner recipes for tonight", icon: "icon_steak", priority: 10 },
      { title: "Quick & Easy", prompt: "Show me 3 simple dinner ideas under 45 minutes", icon: "icon_pasta", priority: 9 },
      { title: "Family Style", prompt: "Give me 3 crowd-pleasing dinner recipes", icon: "icon_pizza", priority: 8 }
    ],
    night: [
      { title: "Late Night Eats", prompt: "Show me 3 simple late-night snack recipes", icon: "icon_cookie", priority: 10 },
      { title: "Light Bites", prompt: "Give me 3 easy snack ideas for now", icon: "icon_lemonade", priority: 9 }
    ]
  };
  
  return fallbackSets[timeOfDay] || fallbackSets.evening;
}

module.exports = {
  generatePersonalizedRecipePrompts
}; 