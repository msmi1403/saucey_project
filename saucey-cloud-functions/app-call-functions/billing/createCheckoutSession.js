const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getStripeClient, getPriceIds } = require('./stripeService');
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already done
if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();

exports.createCheckoutSession = onCall(async (request) => {
    // Verify user is authenticated
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const { priceType, successUrl, cancelUrl } = request.data;
    const userId = request.auth.uid;
    const userEmail = request.auth.token.email;

    // Validate input
    if (!priceType || !['monthly', 'annual'].includes(priceType)) {
        throw new HttpsError('invalid-argument', 'priceType must be "monthly" or "annual"');
    }

    if (!successUrl || !cancelUrl) {
        throw new HttpsError('invalid-argument', 'successUrl and cancelUrl are required');
    }

    try {
        console.log(`Creating checkout session for user ${userId}, plan: ${priceType}`);
        
        const stripe = await getStripeClient();
        const priceIds = await getPriceIds();
        const priceId = priceIds[priceType];

        // Check if user already has a Stripe customer ID
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data() || {};
        
        let customerId = userData.stripeCustomerId;
        
        // For test mode, always create a new customer to avoid live/test mode conflicts
        const secretKey = await require('./stripeService').getSecret('stripe-secret-key');
        const isTestMode = secretKey.includes('test');
        
        if (isTestMode) {
            // In test mode, always create a new customer
            const customer = await stripe.customers.create({
                email: userEmail,
                metadata: {
                    userId: userId,
                    source: 'saucey_app_test'
                }
            });
            customerId = customer.id;
            console.log(`Created new test Stripe customer: ${customerId}`);
        } else {
            // In live mode, use existing customer or create new one
            if (!customerId) {
                const customer = await stripe.customers.create({
                    email: userEmail,
                    metadata: {
                        userId: userId,
                        source: 'saucey_app'
                    }
                });
                customerId = customer.id;
                
                // Save customer ID to Firestore
                await db.collection('users').doc(userId).set({
                    stripeCustomerId: customerId
                }, { merge: true });
                
                console.log(`Created new Stripe customer: ${customerId}`);
            }
        }

        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl,
            allow_promotion_codes: true, // For future referral codes
            metadata: {
                userId: userId,
                priceType: priceType
            },
            subscription_data: {
                metadata: {
                    userId: userId,
                    priceType: priceType
                }
            }
        });

        console.log(`Created checkout session: ${session.id} for user: ${userId}`);

        return {
            sessionId: session.id,
            url: session.url
        };

    } catch (error) {
        console.error('Error creating checkout session:', error);
        throw new HttpsError('internal', `Failed to create checkout session: ${error.message}`);
    }
}); 