const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getStripeClient, getPriceIds, getPublishableKey } = require('./stripeService');
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already done
if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();

exports.getSubscriptionInfo = onCall(async (request) => {
    // Verify user is authenticated
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = request.auth.uid;

    try {
        console.log(`Getting subscription info for user ${userId}`);
        
        // Get user's subscription data from Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        
        // Get available plans and pricing
        const priceIds = await getPriceIds();
        const publishableKey = await getPublishableKey();
        
        // Format subscription data to match iOS expectations
        const subscription = userData.subscription || {};
        const currentSubscription = {
            status: subscription.status || null,
            plan: subscription.plan || 'free',
            stripeCustomerId: subscription.stripeCustomerId || null,
            stripeSubscriptionId: subscription.stripeSubscriptionId || null,
            currentPeriodEnd: subscription.currentPeriodEnd ? subscription.currentPeriodEnd.toDate().toISOString() : null,
            createdAt: subscription.createdAt ? subscription.createdAt.toDate().toISOString() : null
        };

        const subscriptionInfo = {
            // User's current subscription
            currentSubscription: currentSubscription,
            
            // User's feature access
            features: userData.features || {
                canAccessMealPlans: false,
                canAccessFullCookbook: false,
                savedRecipesLimit: 3,
                canAccessChefPersonalities: false,
                canAccessIngredientsContext: false
            },
            
            // Available plans
            availablePlans: [
                {
                    id: 'free',
                    name: 'Free',
                    price: 0,
                    interval: null,
                    features: [
                        'Access to recipe chat',
                        'Save 3 recipes to cookbook',
                        'Basic grocery cart access'
                    ]
                },
                {
                    id: 'premium_monthly',
                    name: 'Premium Monthly',
                    price: 5.00,
                    interval: 'month',
                    stripePriceId: priceIds.monthly,
                    monthlyEquivalent: null,
                    features: [
                        'Unlimited recipe saves',
                        'Full meal plan access',
                        'Complete cookbook access',
                        'All chef personalities',
                        'Ingredients context feature',
                        'Priority support'
                    ]
                },
                {
                    id: 'premium_annual',
                    name: 'Premium Annual',
                    price: 48.00,
                    interval: 'year',
                    monthlyEquivalent: 4.00,
                    stripePriceId: priceIds.annual,
                    features: [
                        'Unlimited recipe saves',
                        'Full meal plan access',
                        'Complete cookbook access',
                        'All chef personalities',
                        'Ingredients context feature',
                        'Priority support',
                        '17% savings vs monthly'
                    ]
                }
            ],
            
            // Stripe publishable key for frontend
            stripePublishableKey: publishableKey
        };

        console.log(`Retrieved subscription info for user: ${userId}`);
        return subscriptionInfo;

    } catch (error) {
        console.error('Error getting subscription info:', error);
        throw new HttpsError('internal', `Failed to get subscription info: ${error.message}`);
    }
});

exports.checkFeatureAccess = onCall(async (request) => {
    // Verify user is authenticated
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { feature } = request.data;
    const userId = request.auth.uid;

    if (!feature) {
        throw new HttpsError('invalid-argument', 'feature is required');
    }

    try {
        console.log(`Checking feature access for user ${userId}, feature: ${feature}`);
        
        // Get user's feature access from Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        const features = userData.features || {
            canAccessMealPlans: false,
            canAccessFullCookbook: false,
            savedRecipesLimit: 3,
            canAccessChefPersonalities: false,
            canAccessIngredientsContext: false
        };

        let hasAccess = false;
        let reason = '';

        switch (feature) {
            case 'meal_plans':
                hasAccess = features.canAccessMealPlans;
                reason = hasAccess ? 'Access granted' : 'Premium subscription required';
                break;
            
            case 'full_cookbook':
                hasAccess = features.canAccessFullCookbook;
                reason = hasAccess ? 'Access granted' : 'Premium subscription required';
                break;
            
            case 'save_recipe':
                // Check if user has reached their saved recipe limit
                const savedRecipesCount = userData.savedRecipesCount || 0;
                const limit = features.savedRecipesLimit;
                
                if (limit === -1) { // Unlimited
                    hasAccess = true;
                    reason = 'Unlimited saves available';
                } else {
                    hasAccess = savedRecipesCount < limit;
                    reason = hasAccess 
                        ? `${limit - savedRecipesCount} saves remaining` 
                        : 'Save limit reached. Upgrade to Premium for unlimited saves';
                }
                break;
            
            case 'chef_personalities':
                hasAccess = features.canAccessChefPersonalities;
                reason = hasAccess ? 'Access granted' : 'Premium subscription required for chef personalities';
                break;
            
            case 'ingredients_context':
                hasAccess = features.canAccessIngredientsContext;
                reason = hasAccess ? 'Access granted' : 'Premium subscription required for ingredients context';
                break;
            
            default:
                throw new HttpsError('invalid-argument', `Unknown feature: ${feature}`);
        }

        return {
            hasAccess,
            reason,
            featureDetails: features
        };

    } catch (error) {
        console.error('Error checking feature access:', error);
        throw new HttpsError('internal', `Failed to check feature access: ${error.message}`);
    }
}); 