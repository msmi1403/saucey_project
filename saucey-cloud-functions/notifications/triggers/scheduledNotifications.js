// saucey-cloud-functions/notifications/triggers/scheduledNotifications.js
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const firestoreHelper = require("@saucey/shared/services/firestoreHelper");
const { analyzeUserActivityAndPrefs } = require("../aiLogic/userAnalyzer");
const {
    generateNotificationContent,
    generateRecipeConcept,
    generateTextualInsight,
    generateRecapNotificationInternal
} = require("../aiLogic/notificationGenerator");
const { dispatchNotification } = require("../services/sendNotification");
const { notificationConfigs } = require("../config/notificationConfig");

const WEEKLY_RECIPE_SUGGESTION = "weeklyRecipeSuggestion";
const MEAL_PLAN_REMINDER = "mealPlanReminder"; // Keep for completeness

const RECENTLY_COOKED_LIMIT = 20;
const RECIPE_CANDIDATE_LIMIT = 10;
const USER_RECIPES_FOR_REMIX_LIMIT = 5;

// findExistingRecipeForUser function remains the same as the last version you have.
// For brevity, I'm not re-pasting it here, but ensure it's the one that:
// - Tries public_recipes (with isPublic, difficulty, keywords filters)
// - Tries user's my_recipes
// - Excludes recentlyCookedIds
// - Returns { id, name, source } or null
async function findExistingRecipeForUser(userContext, recentlyCookedIds) {
    logger.log(`Finding existing recipe for user: ${userContext.userId}, preferences: ${JSON.stringify(userContext.preferences)}, recently cooked count: ${recentlyCookedIds.length}`);
    const { preferences, userId } = userContext;

    // Attempt 1: Find a Public Recipe
    let publicRecipeQueryOptions = {
        where: [{ field: "isPublic", operator: "==", value: true }],
        limit: RECIPE_CANDIDATE_LIMIT * 2,
    };

    if (preferences?.preferredRecipeDifficulty) {
        publicRecipeQueryOptions.where.push({
            field: "difficulty",
            operator: "==",
            value: preferences.preferredRecipeDifficulty
        });
    }

    try {
        const publicRecipeCandidates = await firestoreHelper.getCollection("public_recipes", publicRecipeQueryOptions);
        if (publicRecipeCandidates.length > 0) {
            logger.log(`User ${userId}: Initial public candidates fetched: ${publicRecipeCandidates.length}`);
            let suitablePublicRecipes = publicRecipeCandidates.filter(recipe =>
                recipe.id && recipe.name && !recentlyCookedIds.includes(recipe.id)
            );
            logger.log(`User ${userId}: Public candidates after filtering recently cooked & basic fields: ${suitablePublicRecipes.length}`);

            if (preferences?.selectedDietaryFilters && preferences.selectedDietaryFilters.length > 0) {
                logger.log(`User ${userId}: Applying dietary filters to public recipes: ${JSON.stringify(preferences.selectedDietaryFilters)}`);
                suitablePublicRecipes = suitablePublicRecipes.filter(recipe => {
                    const recipeKeywords = (recipe.keywords || []).map(k => String(k).toLowerCase());
                    return preferences.selectedDietaryFilters.every(filter =>
                        recipeKeywords.includes(String(filter).toLowerCase())
                    );
                });
                logger.log(`User ${userId}: Public candidates after dietary filters: ${suitablePublicRecipes.length}`);
            }

            if (suitablePublicRecipes.length > 0) {
                const chosenRecipe = suitablePublicRecipes[Math.floor(Math.random() * suitablePublicRecipes.length)];
                logger.log(`Selected public recipe for user ${userId}: ${chosenRecipe.name} (ID: ${chosenRecipe.id})`);
                return { id: chosenRecipe.id, name: chosenRecipe.name, source: 'public' };
            }
        } else {
            logger.log(`User ${userId}: No public recipe candidates fetched from Firestore.`);
        }
    } catch (error) {
        logger.error(`Error fetching or filtering public recipes for user ${userId}:`, error);
    }

    // Attempt 2: Find a User's Own Recipe
    logger.log(`No suitable public recipe found for ${userId}. Trying user's personal recipes.`);
    try {
        const personalRecipes = await firestoreHelper.getCollection(`users/${userId}/my_recipes`, { limit: RECIPE_CANDIDATE_LIMIT * 2 });
        if (personalRecipes.length > 0) {
            logger.log(`User ${userId}: Initial personal recipe candidates fetched: ${personalRecipes.length}`);
            const suitablePersonalRecipes = personalRecipes.filter(recipe =>
                recipe.id && recipe.name && !recentlyCookedIds.includes(recipe.id)
            );
            logger.log(`User ${userId}: Personal recipes after filtering recently cooked: ${suitablePersonalRecipes.length}`);

            if (suitablePersonalRecipes.length > 0) {
                const chosenRecipe = suitablePersonalRecipes[Math.floor(Math.random() * suitablePersonalRecipes.length)];
                logger.log(`Selected personal recipe for user ${userId}: ${chosenRecipe.name} (ID: ${chosenRecipe.id})`);
                return { id: chosenRecipe.id, name: chosenRecipe.name, source: 'personal' };
            }
        } else {
            logger.log(`User ${userId}: No personal recipes found in 'my_recipes'.`);
        }
    } catch (error) {
        logger.error(`Error fetching or filtering personal recipes for user ${userId}:`, error);
    }

    logger.warn(`No suitable existing recipe (public or personal, not recently cooked) found for user ${userId}.`);
    return null;
}


exports.sendWeeklyRecipeSuggestions = onSchedule({ schedule: "every monday 10:50", timeZone: "America/New_York" }, async (event) => {
    logger.log(`Running ${WEEKLY_RECIPE_SUGGESTION} trigger. Event ID: ${event.id || 'N/A'}`);
    const config = notificationConfigs[WEEKLY_RECIPE_SUGGESTION];
    if (!config || !config.isEnabled) {
        logger.warn(`${WEEKLY_RECIPE_SUGGESTION} is not configured or disabled. Exiting.`);
        return;
    }

    try {
        const usersSnapshot = await firestoreHelper.getCollection("users", { /* Add filters for active users if desired */ });

        for (const userDoc of usersSnapshot) {
            // Initial checks for userDoc.id and fcmTokens are handled by dispatchNotification, 
            // but an early exit here can save some processing if fcmTokens are known to be empty.
            // However, dispatchNotification also checks preferences, which might be relevant even if tokens are temporarily empty.
            // For now, let dispatchNotification handle the primary checks for user validity and preferences.
            logger.log(`Processing user ${userDoc.id} for ${WEEKLY_RECIPE_SUGGESTION}`);

            const userContext = await analyzeUserActivityAndPrefs(userDoc.id, userDoc);
            if (!userContext) {
                logger.warn(`Could not generate user context for ${userDoc.id}. Skipping.`);
                continue;
            }

            let recentlyCookedIds = [];
            try {
                const cookLogSnapshot = await firestoreHelper.getCollection(`users/${userDoc.id}/cook_log`, {
                    orderBy: [{ field: "timestamp", direction: "desc" }],
                    limit: RECENTLY_COOKED_LIMIT
                });
                if (Array.isArray(cookLogSnapshot)) {
                    recentlyCookedIds = cookLogSnapshot.map(logEntry => logEntry.recipeId).filter(id => !!id);
                } else {
                    logger.warn(`Cook log snapshot ('cook_log') was not an array for user ${userDoc.id}.`);
                }
            } catch (historyError) {
                logger.warn(`Error fetching 'cook_log' for user ${userDoc.id}:`, historyError);
            }

            let suggestionStrategy = "existingRecipe";
            let recipeDynamicData = {}; 
            let calculatedDeepLink = config.defaultDeepLinkBase || "saucey://home"; // Start with a base default
            let performAISuggestionAndDispatch = false; 

            // Initial Strategy Selection (Random)
            const rand = Math.random();
            if (rand < 0.6) {
                suggestionStrategy = "existingRecipe";
            } else if (rand < 0.8) {
                suggestionStrategy = "recipeIdea";
            } else {
                const personalRecipes = await firestoreHelper.getCollection(`users/${userDoc.id}/my_recipes`, { limit: USER_RECIPES_FOR_REMIX_LIMIT });
                if (personalRecipes.length > 0) {
                    suggestionStrategy = "recipeRemix";
                    recipeDynamicData.existingRecipeForRemix = personalRecipes[Math.floor(Math.random() * personalRecipes.length)];
                } else {
                    suggestionStrategy = "surpriseMeRecipeConcept"; // Fallback if no personal recipes for remix
                }
            }
            logger.log(`User ${userDoc.id}: Initial selected strategy: ${suggestionStrategy}`);

            // --- Execute selected strategy OR FALLBACK ---
            if (suggestionStrategy === "existingRecipe") {
                const existingRecipe = await findExistingRecipeForUser(userContext, recentlyCookedIds);
                if (existingRecipe?.id && existingRecipe.name) {
                    recipeDynamicData.recipeId = existingRecipe.id;
                    recipeDynamicData.recipeName = existingRecipe.name;
                    calculatedDeepLink = (config.defaultDeepLinkBase || "saucey://recipe/").endsWith('/') ?
                                        `${config.defaultDeepLinkBase}${existingRecipe.id}` :
                                        `${config.defaultDeepLinkBase}/${existingRecipe.id}`;
                    performAISuggestionAndDispatch = true;
                } else {
                    logger.warn(`No existing recipe found for user ${userDoc.id} with 'existingRecipe' strategy. FALLING BACK to 'recipeIdea'.`);
                    suggestionStrategy = "recipeIdea"; 
                }
            }

            if (suggestionStrategy === "recipeIdea" || suggestionStrategy === "surpriseMeRecipeConcept") {
                const ideaConcept = await generateRecipeConcept(WEEKLY_RECIPE_SUGGESTION, userContext, suggestionStrategy === "recipeIdea" ? 'idea' : 'surprise');
                if (ideaConcept) {
                    recipeDynamicData.recipeIdea = ideaConcept;
                    calculatedDeepLink = `${config.chatDeepLinkBase || "saucey://aichat?prompt="}${encodeURIComponent(ideaConcept)}`;
                    performAISuggestionAndDispatch = true;
                } else {
                    logger.warn(`Failed to generate recipe idea/surprise for user ${userDoc.id} (strategy: ${suggestionStrategy}). Skipping.`);
                }
            }
            else if (suggestionStrategy === "recipeRemix") {
                if (recipeDynamicData.existingRecipeForRemix?.name) {
                    const remixConcept = await generateRecipeConcept(
                        WEEKLY_RECIPE_SUGGESTION,
                        userContext,
                        'remix',
                        recipeDynamicData.existingRecipeForRemix.name
                    );
                    if (remixConcept) {
                        recipeDynamicData.remixIdea = remixConcept;
                        recipeDynamicData.originalRecipeNameForRemixDisplay = recipeDynamicData.existingRecipeForRemix.name;
                        const promptForChat = `Remix idea for "${recipeDynamicData.existingRecipeForRemix.name}": ${remixConcept}`;
                        calculatedDeepLink = `${config.chatDeepLinkBase || "saucey://aichat?prompt="}${encodeURIComponent(promptForChat)}`;
                        performAISuggestionAndDispatch = true;
                    } else {
                        logger.warn(`Failed to generate remix concept for user ${userDoc.id}. FALLING BACK to 'recipeIdea'.`);
                        suggestionStrategy = "recipeIdea"; 
                        const ideaConceptFallback = await generateRecipeConcept(WEEKLY_RECIPE_SUGGESTION, userContext, 'idea');
                        if (ideaConceptFallback) {
                            recipeDynamicData.recipeIdea = ideaConceptFallback;
                            recipeDynamicData.remixIdea = undefined; 
                            recipeDynamicData.originalRecipeNameForRemixDisplay = undefined;
                            calculatedDeepLink = `${config.chatDeepLinkBase || "saucey://aichat?prompt="}${encodeURIComponent(ideaConceptFallback)}`;
                            performAISuggestionAndDispatch = true;
                        } else {
                             logger.warn(`Fallback 'recipeIdea' also failed for user ${userDoc.id}. Skipping.`);
                        }
                    }
                } else {
                    logger.warn(`No existing personal recipe found for remix strategy for user ${userDoc.id}. FALLING BACK to 'recipeIdea'.`);
                    suggestionStrategy = "recipeIdea";
                    const ideaConceptFallback = await generateRecipeConcept(WEEKLY_RECIPE_SUGGESTION, userContext, 'idea');
                    if (ideaConceptFallback) {
                        recipeDynamicData.recipeIdea = ideaConceptFallback;
                        calculatedDeepLink = `${config.chatDeepLinkBase || "saucey://aichat?prompt="}${encodeURIComponent(ideaConceptFallback)}`;
                        performAISuggestionAndDispatch = true;
                    } else {
                         logger.warn(`Fallback 'recipeIdea' also failed for user ${userDoc.id}. Skipping.`);
                    }
                }
            }

            if (performAISuggestionAndDispatch) {
                recipeDynamicData.suggestionStrategy = suggestionStrategy; 
                recipeDynamicData.deepLinkOverride = calculatedDeepLink; // Pass the calculated deep link

                const aiGeneratedNotificationContent = await generateNotificationContent(
                    WEEKLY_RECIPE_SUGGESTION,
                    userContext,
                    recipeDynamicData // Pass the rich dynamic data which might include recipeName, recipeIdea, etc.
                );

                if (aiGeneratedNotificationContent?.title && aiGeneratedNotificationContent?.body) {
                    logger.info(`Dispatching ${WEEKLY_RECIPE_SUGGESTION} for user ${userDoc.id} with strategy '${suggestionStrategy}'`, 
                                { userId: userDoc.id, strategy: suggestionStrategy, dynamicData: recipeDynamicData });
                    
                    await dispatchNotification(
                        userDoc.id,
                        WEEKLY_RECIPE_SUGGESTION,
                        recipeDynamicData, // Contains recipeId, recipeName, recipeIdea, etc., AND deepLinkOverride
                        aiGeneratedNotificationContent // Expected: { title, body, emoji }
                    );
                } else {
                    logger.warn(`AI content generation failed for ${WEEKLY_RECIPE_SUGGESTION} for user ${userDoc.id}. Skipping notification.`);
                }
            } else {
                 logger.info(`No suitable suggestion strategy yielded content for user ${userDoc.id}. Skipping notification.`);
            }
        } // End of user loop
    } catch (error) {
        logger.error(`Error in ${WEEKLY_RECIPE_SUGGESTION} scheduled function:`, error);
    }
});

// --- sendMealPlanReminders function (ensure it's robust as per previous versions) ---
exports.sendMealPlanReminders = onSchedule({ schedule: "every day 19:00", timeZone: "America/New_York" }, async (event) => {
    // ... (ensure this function is using the latest robust logic for deep links and error handling)
    // For brevity, keeping it as previously provided, assuming it's up to date.
    // The key is that `finalDynamicData` with `deepLinkOverride` is correctly passed to sendTargetedNotification.
    logger.log(`Running ${MEAL_PLAN_REMINDER} trigger. Event ID: ${event.id || 'N/A'}`);
    const config = notificationConfigs[MEAL_PLAN_REMINDER];
    if (!config || !config.isEnabled) {
        logger.warn(`${MEAL_PLAN_REMINDER} is not configured or disabled. Exiting.`);
        return;
    }
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDateString = tomorrow.toISOString().split('T')[0];

        const usersSnapshot = await firestoreHelper.getCollection("users");
        for (const userDoc of usersSnapshot) {
            if (!userDoc.id || !userDoc.fcmTokens || userDoc.fcmTokens.length === 0) continue;

            const mealPlanDoc = await firestoreHelper.getDocument(`users/${userDoc.id}/mealPlans`, tomorrowDateString);
            if (mealPlanDoc && mealPlanDoc.meals && mealPlanDoc.meals.length > 0) {
                for (const meal of mealPlanDoc.meals) {
                    if (meal.recipeName && meal.recipeId && meal.mealType) {
                        const userContext = await analyzeUserActivityAndPrefs(userDoc.id, userDoc);
                        if (!userContext) {
                             logger.warn(`Could not get user context for ${userDoc.id} during meal plan reminder. Skipping this meal.`);
                             continue;
                        }

                        const dynamicData = {
                            recipeId: meal.recipeId,
                            recipeName: meal.recipeName,
                            mealType: meal.mealType,
                            suggestionStrategy: "existingRecipe"
                        };

                        let finalDeepLink = config.defaultDeepLinkBase || `saucey://mealplan`;
                        if (dynamicData.recipeId && config.defaultDeepLinkBase && config.defaultDeepLinkBase.includes("recipe")) {
                             finalDeepLink = config.defaultDeepLinkBase.endsWith('/') ?
                                `${config.defaultDeepLinkBase}${dynamicData.recipeId}` :
                                `${config.defaultDeepLinkBase}/${dynamicData.recipeId}`;
                        } else if (config.defaultDeepLinkBase && config.defaultDeepLinkBase.includes("mealplan") && tomorrowDateString) {
                            finalDeepLink = config.defaultDeepLinkBase.endsWith('/') ?
                                `${config.defaultDeepLinkBase}${tomorrowDateString}` :
                                `${config.defaultDeepLinkBase}/${tomorrowDateString}`;
                        }

                        const finalDynamicData = { ...dynamicData, deepLinkOverride: finalDeepLink };
                        const aiContent = await generateNotificationContent(MEAL_PLAN_REMINDER, userContext, dynamicData);
                        await dispatchNotification(userDoc.id, MEAL_PLAN_REMINDER, finalDynamicData, aiContent);
                    }
                }
            }
        }
        logger.log(`${MEAL_PLAN_REMINDER} trigger finished.`);
    } catch (error) {
        logger.error(`Error in ${MEAL_PLAN_REMINDER} trigger:`, error);
    }
    logger.log("Finished processing sendMealPlanReminders.");
});

// New Scheduled Function for Weekly Recap
exports.sendWeeklyRecapNotifications = onSchedule({ schedule: "every sunday 18:00", timeZone: "America/New_York" }, async (event) => {
    const notificationType = "weeklyCookingRecap";
    logger.log(`Running ${notificationType} trigger. Event ID: ${event.id || 'N/A'}`);
    const config = notificationConfigs[notificationType];

    if (!config || !config.isEnabled) {
        logger.warn(`${notificationType} is not configured or disabled. Exiting.`);
        return;
    }

    try {
        // TODO: Add filtering for active users with FCM tokens if not done by default in getCollection or user analysis
        const usersSnapshot = await firestoreHelper.getCollection("users");

        for (const userDoc of usersSnapshot) {
            if (!userDoc.id || !userDoc.fcmTokens || userDoc.fcmTokens.length === 0) {
                logger.info(`Skipping user ${userDoc.id || 'unknown'} for ${notificationType} due to missing ID or FCM tokens.`);
                continue;
            }
            logger.log(`Processing user ${userDoc.id} for ${notificationType}`);

            const userContext = await analyzeUserActivityAndPrefs(userDoc.id, userDoc);
            if (!userContext) {
                logger.warn(`Could not generate user context for ${userDoc.id}. Skipping for ${notificationType}.`);
                continue;
            }

            // Fetch cooking activity for the past 7 days
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            let cookLogEntries = [];
            try {
                cookLogEntries = await firestoreHelper.getCollection(`users/${userDoc.id}/cook_log`, {
                    where: [{ field: "cookedDate", operator: ">=", value: sevenDaysAgo }],
                    orderBy: [{ field: "cookedDate", direction: "desc" }]
                });
            } catch (logError) {
                logger.error(`Error fetching cook_log for user ${userDoc.id}:`, logError);
                // Continue, will result in "didn't log any cooking" message
            }

            let weeklyCookingSummaryString;
            if (cookLogEntries.length > 0) {
                // Fetch recipe names asynchronously
                const recipeNamePromises = cookLogEntries.map(async (entry) => {
                    if (entry.recipeId) {
                        try {
                            // Assuming cook_log entries might not have a 'source' field to distinguish
                            // between 'my_recipes' and 'public_recipes'.
                            // We'll try 'my_recipes' first, then 'public_recipes'.
                            // You might need a more robust way to determine the source if it varies.
                            let recipeDoc = await firestoreHelper.getDocument(`users/${userDoc.id}/my_recipes`, entry.recipeId);
                            if (recipeDoc && recipeDoc.title) {
                                return recipeDoc.title;
                            }
                            // Fallback to public_recipes if not found in user's recipes or if no title
                            recipeDoc = await firestoreHelper.getDocument('public_recipes', entry.recipeId);
                            if (recipeDoc && recipeDoc.title) {
                                return recipeDoc.title;
                            }
                            return entry.recipeName || "a recipe"; // Fallback if not found or no title
                        } catch (fetchError) {
                            logger.warn(`Error fetching recipe title for ID ${entry.recipeId}, user ${userDoc.id}:`, fetchError);
                            return entry.recipeName || "a recipe"; // Fallback on error
                        }
                    }
                    return entry.recipeName || "a recipe"; // Fallback if no recipeId
                });

                const resolvedRecipeNames = (await Promise.all(recipeNamePromises)).slice(0, 2);

                const cuisines = [...new Set(cookLogEntries.map(entry => entry.cuisine).filter(c => c))];
                let summary = `This week you cooked ${cookLogEntries.length} recipe${cookLogEntries.length > 1 ? 's' : ''}`;
                if (resolvedRecipeNames.length > 0) {
                    summary += `, including ${resolvedRecipeNames.join(' and ')}`;
                }
                if (cuisines.length > 0) {
                    summary += `. You explored ${cuisines.join(', ')} cuisine${cuisines.length > 1 ? 's' : ''}!`;
                } else {
                    summary += "!";
                }
                weeklyCookingSummaryString = summary;
            } else {
                weeklyCookingSummaryString = "This week you didn\'t log any cooking. Time to find a new favorite!";
            }
            logger.info(`User ${userDoc.id} weekly summary: "${weeklyCookingSummaryString}"`);

            // Determine nextWeekFocusString
            let nextWeekFocusString = "Explore a new recipe genre this week!"; // Default focus
            const focusPromptName = 'aiSystemPromptForNextWeekFocus';
            if (config[focusPromptName]) {
                const generatedFocus = await generateTextualInsight(
                    focusPromptName,
                    userContext,
                    { PAST_WEEK_COOKING_SUMMARY: weeklyCookingSummaryString }
                );
                if (generatedFocus) {
                    nextWeekFocusString = generatedFocus;
                } else {
                    logger.warn(`Failed to generate next week focus for user ${userDoc.id}. Using default.`);
                }
            } else {
                logger.warn(`'${focusPromptName}' not found in config. Using default focus for user ${userDoc.id}.`);
            }
            logger.info(`User ${userDoc.id} next week focus: "${nextWeekFocusString}"`);

            // Generate Notification Content
            let notificationContent = await generateRecapNotificationInternal(
                userContext,
                weeklyCookingSummaryString,
                nextWeekFocusString
            );

            if (!notificationContent) {
                logger.warn(`AI content generation failed for ${notificationType} for user ${userDoc.id}. Falling back to default content.`);
                notificationContent = { ...config.defaultContent };
                // Slightly personalize default content if possible
                if (userContext.displayName) {
                    notificationContent.title = notificationContent.title.replace("Your", `${userContext.displayName}\'s`);
                }
            }

            // Send Notification
            const deepLink = config.defaultDeepLinkBase || "saucey://home"; // Default deep link
            await dispatchNotification(
                userDoc.id,
                notificationType,
                { deepLinkOverride: deepLink }, // dynamicData
                notificationContent // This is { title, body, emoji }
            );
            logger.info(`Successfully processed and sent ${notificationType} for user ${userDoc.id}`);

        } // End of user loop

        logger.log(`Finished processing ${notificationType}.`);

    } catch (error) {
        logger.error(`Error in ${notificationType} scheduled function:`, error);
    }
});