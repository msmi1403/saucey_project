// saucey-cloud-functions/handleRecipeChatTurn/commonutils.js (or recipeUtils.js)
const config = require('./config');
const sharedCommonUtils = require('../shared/utils/commonUtils'); // Path to the new shared utils

// This function is now specific to validating image types FOR RECIPES
function isValidImageMimeTypeForRecipes(mimeType) {
    return sharedCommonUtils.isValidMimeType(mimeType, config.SUPPORTED_IMAGE_MIME_TYPES);
}

/**
 * Normalizes a single ingredient item into a dictionary with consistent keys.
 * Mimics the Python coerce_to_ingredient.
 * @param {*} item - The ingredient item (string or object).
 * @returns {object} Normalized ingredient object.
 */
function coerceToIngredient(item) {
    const defaultIngredient = {
        quantity: null,
        unit: null,
        item_name: config.DEFAULT_INGREDIENT_NAME, // from config.js
        isSecret: false, // Default
        category: config.DEFAULT_INGREDIENT_CATEGORY // from config.js
    };

    if (typeof item === 'string') {
        return { ...defaultIngredient, item_name: item.trim() || config.DEFAULT_INGREDIENT_NAME };
    }

    if (typeof item === 'object' && item !== null) {
        let quantity = null;
        if (item.quantity !== undefined && item.quantity !== null) {
            const num = parseFloat(item.quantity);
            if (!isNaN(num)) {
                quantity = num;
            }
        }

        let unit = item.unit;
        if (typeof unit === 'string') {
            unit = unit.trim() || null;
        } else {
            unit = null;
        }

        let itemName = item.item_name || item.name || '';
        itemName = itemName.trim() || config.DEFAULT_INGREDIENT_NAME;

        return {
            quantity: quantity,
            unit: unit,
            item_name: itemName,
            isSecret: typeof item.isSecret === 'boolean' ? item.isSecret : false,
            category: (typeof item.category === 'string' && item.category.trim()) ? item.category.trim() : config.DEFAULT_INGREDIENT_CATEGORY,
        };
    }
    console.warn(`coerceToIngredient: Unexpected item type ${typeof item}. Returning default unknown ingredient.`);
    return { ...defaultIngredient, item_name: config.DEFAULT_UNKNOWN_INGREDIENT || "Unknown Ingredient" };
}


module.exports = {
    isValidImageMimeTypeForRecipes, // Export with a potentially more specific name
    coerceToIngredient,
};