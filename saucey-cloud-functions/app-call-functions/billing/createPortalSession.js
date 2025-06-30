const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getStripeClient } = require('./stripeService');
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already done
if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();

exports.createPortalSession = onCall(async (request) => {
    // Verify user is authenticated
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { returnUrl } = request.data;
    const userId = request.auth.uid;

    if (!returnUrl) {
        throw new HttpsError('invalid-argument', 'returnUrl is required');
    }

    try {
        console.log(`Creating portal session for user ${userId}`);
        
        // Get user's Stripe customer ID
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        
        if (!userData || !userData.subscription) {
            throw new HttpsError('failed-precondition', 'User has no subscription data');
        }
        
        // Try to get customer ID from subscription first, then fall back to root level
        const subscription = userData.subscription || {};
        let customerId = subscription.stripeCustomerId || userData.stripeCustomerId;
        
        if (!customerId) {
            throw new HttpsError('failed-precondition', 'User has no Stripe customer ID');
        }

        console.log(`Attempting to create portal session for customer: ${customerId}`);

        const stripe = await getStripeClient();
        
        // Create portal session
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        console.log(`Created portal session: ${session.id} for user: ${userId}`);

        return {
            url: session.url
        };

    } catch (error) {
        console.error('Error creating portal session:', error);
        
        // Handle specific Stripe errors
        if (error.type === 'StripeInvalidRequestError' && error.code === 'resource_missing') {
            if (error.message.includes('similar object exists in live mode')) {
                throw new HttpsError('failed-precondition', 
                    'Your subscription was created in live mode but the app is running in test mode. Please contact support or create a new test subscription.');
            } else {
                throw new HttpsError('failed-precondition', 
                    'Your subscription customer ID is invalid. Please try creating a new subscription.');
            }
        }
        
        throw new HttpsError('internal', `Failed to create portal session: ${error.message}`);
    }
}); 