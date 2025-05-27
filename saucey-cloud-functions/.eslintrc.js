module.exports = {
  env: {
    es2021: true,
    node: true,
  },
  extends: 'eslint:recommended',
  parserOptions: {
    ecmaVersion: 12,
    sourceType: 'commonjs',
  },
  rules: {
    'no-console': 'off', // Or 'warn' if you want to be reminded
    'indent': ['error', 2],
    'linebreak-style': ['error', 'unix'],
    'quotes': ['error', 'single'],
    'semi': ['error', 'always'],
  },
  ignorePatterns: ["node_modules/", "dist/", ".eslintrc.js"], // Added .eslintrc.js to ignore itself
}; 