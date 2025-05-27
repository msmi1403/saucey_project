/**
 * Formats raw recipe data into a summary object suitable for client display.
 * @param {object} recipeData - The raw recipe data from Firestore.
 * @param {string} recipeId - The ID of the recipe.
 * @returns {object|null} A formatted recipe summary object, or null if no data.
 */
function formatRecipeSummary(recipeData, recipeId) {
  if (!recipeData) return null;
  return {
    recipeId: recipeId || recipeData.recipeId, // Ensure recipeId is present
    title: recipeData.title || null,
    imageURL: recipeData.imageURL || null,
    createdByUsername: recipeData.createdByUsername || null,
    createdByUserId: recipeData.createdByUserId || null, // Added this, might be useful for client
    saveCount: recipeData.saveCount || 0,
    total_time: recipeData.total_time || null,
    // calories: recipeData.calories || null, // Example: if you add this field later
    averageRating: recipeData.averageRating || null,
    reviewCount: recipeData.reviewCount || 0,
    // Add other fields as they become common for summaries
  };
}

module.exports = {
  formatRecipeSummary,
}; 