// utils/normalizeRecipe.js

/**
 * Turn a raw schema.org Recipe JSON-LD object into a flat JS object:
 * {
 *   name, description,
 *   ingredients: string[],
 *   instructions: string[],
 *   prepTime, cookTime, totalTime,
 *   yield, author, image
 * }
 */
function normalizeRecipe(recipe) {
  const {
    name = '',
    description = '',
    recipeIngredient,
    recipeInstructions,
    prepTime = '',
    cookTime = '',
    totalTime = '',
    recipeYield,
    author,
    image
  } = recipe;

  // flatten instructions: they can be strings or { text: '' }
  const instructions = Array.isArray(recipeInstructions)
    ? recipeInstructions.map(step => {
        if (typeof step === 'string') return step;
        if (step.text)               return step.text;
        if (step['@type'] === 'HowToSection' && Array.isArray(step.itemListElement)) {
          // sometimes nested sections
          return step.itemListElement.map(s => s.text || '').join(' ');
        }
        return JSON.stringify(step); // fallback
      })
    : [];

  // flatten author field
  let authorName = '';
  if (typeof author === 'string')      authorName = author;
  else if (Array.isArray(author))      authorName = author.map(a => a.name || '').join(', ');
  else if (author && author.name)      authorName = author.name;

  // flatten image field
  const imageUrl = Array.isArray(image) ? image[0] : (typeof image === 'string' ? image : (image?.url || ''));

  return {
    name,
    description,
    ingredients: Array.isArray(recipeIngredient) ? recipeIngredient : [],
    instructions,
    prepTime,
    cookTime,
    totalTime,
    yield: recipeYield || '',
    author: authorName,
    image: imageUrl,
    // pass along the original for full context
    _raw: recipe
  };
}

module.exports = { normalizeRecipe };
