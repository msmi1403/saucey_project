// saucey-cloud-functions/notifications/config/notificationConfig.js
const { GEMINI_MODEL_NAME_TEXT_GENERATION } = require("@saucey/shared/config/globalConfig"); // Import from shared config

/**
 * @typedef {Object} NotificationContent
 * @property {string} title - The title of the notification.
 * @property {string} body - The body of the notification.
 * @property {string} [emoji] - An optional emoji for the notification.
 * @property {string} [deepLink] - An optional deep link for the notification.
 */

/**
 * @typedef {Object} NotificationTypeConfig
 * @property {string} notificationType - A unique identifier for the notification type.
 * @property {string} description - A description of what this notification is for.
 * @property {boolean} isEnabled - Whether this type of notification is globally enabled.
 * @property {NotificationContent} defaultContent - Default content if no A/B test or AI generation is used.
 * @property {string} [aiSystemPromptForStory] - System prompt for Gemini to generate a culinary story/hook for existing recipes.
 * @property {string} aiSystemPromptForNotificationContent - System prompt for Gemini to generate title/body/emoji for existing recipes.
 * @property {string} [aiSystemPromptForRecipeIdea] - System prompt for generating a new recipe idea/concept.
 * @property {string} [aiSystemPromptForRecipeRemix] - System prompt for generating a remix idea for an existing recipe.
 * @property {string} [targetAudienceCriteria] - (Conceptual) Criteria for targeting users.
 * @property {string} [defaultDeepLinkBase] - Base URL for deep links, e.g., "saucey://recipe/".
 * @property {string} [chatDeepLinkBase] - Base URL for deep links to AI chat, e.g., "saucey://aichat?prompt=".
 * @property {Object} [abTest] - Optional A/B test configuration for this notification type (from config file).
 */

/** @type {Object<string, NotificationTypeConfig>} */
const notificationConfigs = {
    weeklyRecipeSuggestion: {
        notificationType: "weeklyRecipeSuggestion",
        description: "Weekly recipe suggestion based on user preferences and activity. Can be an existing recipe, a new idea, or a remix.",
        isEnabled: true,
        defaultContent: {
            title: "Fresh Kitchen Inspiration!",
            body: "Discover a new culinary idea tailored for you. Tap to explore!",
            emoji: "💡",
            deepLink: "saucey://home" // General fallback
        },
        // Prompts for suggesting an EXISTING recipe
        aiSystemPromptForStory: `You are a witty and engaging culinary assistant for Saucey.
Based on the user's context and the suggested recipe "{RECIPE_NAME}", craft a short, enticing story or hook (max 2 sentences) to make them curious.
User Activity Context: {USER_CONTEXT}`,
        aiSystemPromptForNotificationContent: `You are an expert at crafting concise, click-optimized push notifications for Saucey.
Based on the culinary story/hook: "{STORY_OR_HOOK}", and the recipe "{RECIPE_NAME}", generate:
1. A short, attention-grabbing "title" (max 40 characters).
2. An engaging "body" (max 120 characters) including the recipe name.
3. A single relevant "emoji".
Output ONLY a JSON object: {"title": "...", "body": "...", "emoji": "..."}`,

        // Prompts for HYBRID strategies
        aiSystemPromptForRecipeIdea: `You are Saucey's creative chef, dreaming up unique recipe ideas.
Based on the user's context: {USER_CONTEXT}.
Generate a short, exciting, and unique recipe *concept or title* (e.g., "Spicy Mango Tango Tacos", "Zen Garden Buddha Bowl with Miso Tahini Dressing").
The output should be JUST the recipe concept string, max 15 words.
Recipe Concept:`,
        aiSystemPromptForRecipeRemix: `You are Saucey's innovative recipe developer, known for creative twists on classics.
The user has a recipe called "{EXISTING_RECIPE_NAME}".
User's general context: {USER_CONTEXT}.
Suggest a creative "remix" or variation *concept* for "{EXISTING_RECIPE_NAME}" (e.g., "turn it into a spicy soup", "add a surprising ingredient like chipotle-chocolate sauce", "make a deconstructed version").
The output should be JUST the remix concept string, max 20 words.
Remix Concept for {EXISTING_RECIPE_NAME}:`,
        // This prompt will be used by notificationGenerator to craft the final notification for ideas/remixes
        aiSystemPromptForIdeaNotificationContent: `You are an expert at crafting concise, click-optimized push notifications for Saucey.
You have a recipe *idea* or *remix concept*: "{RECIPE_IDEA_OR_REMIX}".
User context: {USER_CONTEXT}.
Generate a notification to entice the user to explore this idea in the AI chat:
1. A short, attention-grabbing "title" (max 40 characters) related to the idea.
2. An engaging "body" (max 120 characters) mentioning the idea and prompting to "Tap to create it with AI!".
3. A single relevant "emoji".
Output ONLY a JSON object: {"title": "...", "body": "...", "emoji": "..."}`,

        defaultDeepLinkBase: "saucey://recipe/",
        chatDeepLinkBase: "saucey://aichat?prompt=", // For ideas/remixes linking to chat
        abTest: { // Example A/B test still possible for the overall notification type
            experimentId: "weeklyRecipeSuggestion_Overall_June2025",
            isActive: false, // Set to true to activate this config-based A/B test
            variants: [
                // Variants here would typically be for testing overall messaging,
                // as the actual content (recipe vs idea) is determined by strategy.
                // Or, you could test different default messages if no specific content is generated.
                {
                    variantId: "control_default",
                    content: { title: "Your Weekly Saucey Suggestion!", body: "Tap to see what's new for you.", emoji: "🤔" },
                    weight: 100
                }
            ]
        }
    },
    newRecipeFromCreator: {
        notificationType: "newRecipeFromCreator",
        description: "Notifies users when a creator they follow publishes a new recipe.",
        isEnabled: true,
        defaultContent: {
            title: "New Recipe Alert!",
            body: "{CREATOR_NAME} just published: {RECIPE_NAME}!",
            emoji: "🎉"
        },
        aiSystemPromptForNotificationContent: `You are an expert at crafting concise, click-optimized push notifications for Saucey.
A food creator named {CREATOR_NAME} has just published a new recipe: {RECIPE_NAME}.
Generate a notification with:
1. A "title" (max 40 chars) announcing the new recipe, mentioning the creator.
2. A "body" (max 120 chars) highlighting the new recipe.
3. A single relevant "emoji".
Output ONLY a JSON object: {"title": "...", "body": "...", "emoji": "..."}`,
        defaultDeepLinkBase: "saucey://recipe/",
    },
    mealPlanReminder: {
        notificationType: "mealPlanReminder",
        description: "Reminds users about upcoming meals in their plan.",
        isEnabled: true,
        defaultContent: {
            title: "Meal Prep Time!",
            body: "Don't forget to prep for: {RECIPE_NAME} for your {MEAL_TYPE} tomorrow!",
            emoji: "🗓️"
        },
        aiSystemPromptForNotificationContent: `You are an expert at crafting friendly reminders for Saucey.
A user has {RECIPE_NAME} planned for {MEAL_TYPE} tomorrow.
Generate a notification with:
1. A "title" (max 40 chars) like "Meal Prep Reminder!".
2. A "body" (max 120 chars) gently reminding them about the recipe and meal.
3. A single relevant "emoji".
Output ONLY a JSON object: {"title": "...", "body": "...", "emoji": "..."}`,
        defaultDeepLinkBase: "saucey://mealplan/",
    },
    weeklyCookingRecap: {
        notificationType: "weeklyCookingRecap",
        description: "Weekly cooking activity recap and suggested focus for the next week.",
        isEnabled: true,
        defaultContent: {
            title: "Your Weekly Saucey Summary!",
            body: "See what you cooked and get a fun tip for next week!",
            emoji: "🍳"
        },
        aiSystemPromptForNextWeekFocus: "Based on the user\'s activity ({PAST_WEEK_COOKING_SUMMARY}) and their preferences ({USER_CONTEXT_PREFERENCES}), suggest a fun and engaging culinary focus or mini-challenge for them for the upcoming week. Keep it short and inspiring. Output only the suggestion string.",
        aiSystemPromptForWeeklyRecapStory: "You are {USER_PREFERRED_CHEF_PERSONALITY}. Your user, {USER_DISPLAY_NAME}, has the following preferences: {USER_CONTEXT_PREFERENCES}. This past week, they {WEEKLY_COOKING_SUMMARY}. For next week, their focus is: {NEXT_WEEK_FOCUS_SUGGESTION}. Craft a short, engaging, 2-3 sentence recap and motivational message in your distinct personality. Output only the story.",
        aiSystemPromptForWeeklyRecapNotificationContent: "Based on the following recap story: \'Context:{RECAP_STORY}\', generate a concise push notification. Create an attention-grabbing \'title\' (max 40 chars), an engaging \'body\' (max 120 chars), and a single relevant \'emoji\'. Output ONLY a JSON object.",
        defaultDeepLinkBase: "saucey://home",
    },
};

module.exports = {
    notificationConfigs,
    // GEMINI_MODEL_NAME is no longer exported from here if generator uses globalConfig directly
};
