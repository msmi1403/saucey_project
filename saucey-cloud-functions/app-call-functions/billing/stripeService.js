const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const Stripe = require('stripe');

let stripe;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'saucey-3fb0f';
const secretManagerClient = new SecretManagerServiceClient();

/**
 * Gets a secret from Google Secret Manager (NO CACHING for security)
 * @param {string} secretId - The secret ID
 * @returns {Promise<string>} The secret value
 */
async function getSecret(secretId) {
    const secretPath = `projects/${PROJECT_ID}/secrets/${secretId}/versions/latest`;
    
    try {
        const [version] = await secretManagerClient.accessSecretVersion({
            name: secretPath,
        });
        
        const secretValue = version.payload.data.toString('utf8');
        console.log(`Successfully retrieved secret: ${secretId}`);
        return secretValue;
    } catch (error) {
        console.error(`Failed to retrieve secret ${secretId}:`, error);
        throw new Error(`Failed to retrieve secret ${secretId}: ${error.message}`);
    }
}

/**
 * Initializes Stripe client with secret key (NO CACHING for security)
 * @returns {Promise<Stripe>} Initialized Stripe client
 */
async function getStripeClient() {
    const secretKey = await getSecret('stripe-secret-key');
    stripe = new Stripe(secretKey, {
        apiVersion: '2024-12-18.acacia', // Latest API version
    });
    console.log('Stripe client initialized with fresh secret');
    return stripe;
}

/**
 * Gets Stripe price IDs
 * @returns {Promise<{monthly: string, annual: string}>} Price IDs
 */
async function getPriceIds() {
    const [monthly, annual] = await Promise.all([
        getSecret('stripe-monthly-price-id'),
        getSecret('stripe-annual-price-id')
    ]);
    
    return {
        monthly,
        annual
    };
}

/**
 * Gets Stripe publishable key for frontend
 * @returns {Promise<string>} Publishable key
 */
async function getPublishableKey() {
    return await getSecret('stripe-publishable-key');
}

module.exports = {
    getStripeClient,
    getPriceIds,
    getPublishableKey,
    getSecret
}; 