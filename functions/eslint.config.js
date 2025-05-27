// functions/eslint.config.js

// Import necessary modules for ESLint v9 flat config
const globals = require("globals");
const js = require("@eslint/js");

module.exports = [
  // Apply ESLint's recommended rules
  js.configs.recommended,

  // Configuration for all JavaScript files in the project
  {
    languageOptions: {
      // Specify ECMAScript version (adjust if using newer features)
      ecmaVersion: 2018,
      // Specify source type as commonjs (typical for Node.js functions)
      sourceType: "commonjs",
      // Define global variables available in the Node.js environment
      globals: {
        ...globals.node, // Includes common Node.js globals like 'require', 'module', 'exports', 'console', etc.
        // Add any other specific globals your functions use if needed
      },
    },
    // Define rules (can be empty if relying on 'recommended')
    rules: {
      // You can override recommended rules or add new ones here
      // e.g., "quotes": ["error", "double"]
      "max-len": ["error", { "code": 100, "ignoreComments": true, "ignoreUrls": true }], // Example: Set max length to 100, ignore comments/URLs
      "object-curly-spacing": ["error", "always"], // Example: Enforce space inside {}
      "padded-blocks": ["error", "never"], // Example: Disallow padding blank lines in blocks
      // Add other rules as needed
    },
    // Specify files this configuration applies to (optional, defaults to project files)
    // files: ["**/*.js"],
    // Specify files/directories to ignore
    ignores: [
      "node_modules/", // Always ignore node_modules
      // Add other directories or files to ignore if necessary
    ],
  },
];

