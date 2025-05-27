// /handleRecipeChatTurn/prompts/recipeJsonSchema.js
module.exports = {
  type: "object",
  properties: {
    recipeId: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    cuisine: { type: ["string", "null"] },
    category: { type: ["string", "null"] },
    difficulty: { type: ["string", "null"] },
    prepTime: { type: ["string", "null"] }, // Consider "format: duration" if using ajv-formats strictly
    cookTime: { type: ["string", "null"] }, // Consider "format: duration"
    totalTime: { type: ["string", "null"] }, // Consider "format: duration"
    servings: { type: ["number", "null"], minimum: 0 },
    calories: { type: ["string", "null"] },
    ingredients: {
      type: ["array", "null"],
      items: {
        type: "object",
        properties: {
          item_name: { type: "string" },
          quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          isSecret: { type: "boolean", default: false },
          category: { type: "string" }
        },
        // If an ingredient object is present, item_name is required.
        // This can be handled by making the items themselves non-nullable if ingredients array is not null
        // or by further conditional logic if needed.
        // For simplicity, the prompt asks for REQUIRED if ingredients array is present.
        // Ajv can make item_name required if the object exists:
        // "if": { "properties": { "item_name": { "not": { "type": "null" } } } },
        // "then": { "required": ["item_name"] }
        // However, simpler to just make it required for any object in the array:
        required: ["item_name"],
      }
    },
    instructions: {
      type: ["array", "null"],
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          isSecret: { type: "boolean", default: false }
        },
        required: ["text"] // Text is required if an instruction object exists
      }
    },
    tipsAndVariations: { type: ["array", "null"], items: { type: "string" } },
    keywords: { type: ["array", "null"], items: { type: "string" } },
    imageURL: { type: ["string", "null"] }, // Consider "format: uri-reference"
    source: { type: ["string", "null"] },
    isPublic: { type: "boolean", default: false },
    isSecretRecipe: { type: "boolean", default: false },
    conversationalText: { type: ["string", "null"] }
  },
  // Add a conditional logic: if conversationalText is null or not present,
  // then title, ingredients, and instructions should ideally be present.
  // This is a bit complex for a basic Ajv setup without `if/then/else` but good to note.
  // Your current prompt handles this: "ALL other recipe-specific fields above ... MUST be null or omitted"
  // So, if conversationalText is present, other fields should be null. If it's null, then they can be populated.
  // The schema above allows null for most fields, which aligns with this.
};