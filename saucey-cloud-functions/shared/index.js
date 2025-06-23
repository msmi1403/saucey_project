// saucey-cloud-functions/shared/index.js

// This file serves as the main export point for the @saucey/shared package.
// It should export the modules that are intended to be used by other
// packages in the monorepo.

const commonUtils = require('./utils/commonUtils');
const firestoreHelper = require('./services/firestoreHelper');
const geminiClient = require('./services/geminiClient');
const globalConfig = require('./config/globalConfig');

module.exports = {
  commonUtils,
  firestoreHelper,
  geminiClient,
  globalConfig,
};