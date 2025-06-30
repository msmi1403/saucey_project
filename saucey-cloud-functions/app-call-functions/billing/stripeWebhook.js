const { onRequest } = require('firebase-functions/v2/https');
const { getStripeClient, getSecret } = require('./stripeService');
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already done
if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();

exports.stripeWebhook = onRequest({
    cors: false, // Disable CORS for webhook
}, async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    // Get raw body for signature verification
    let body;
    if (req.rawBody) {
        body = req.rawBody;
    } else {
        // Fallback: convert parsed body back to string
        body = JSON.stringify(req.body);
    }

    if (!sig) {
        console.error('Missing stripe-signature header');
        return res.status(400).send('Missing stripe-signature header');
    }

    try {
        const stripe = await getStripeClient();
        const webhookSecret = await getSecret('stripe-webhook-secret');
        
        // Verify webhook signature
        const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
        
        console.log(`Processing webhook event: ${event.type}`);

        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSessionCompleted(event.data.object);
                break;
            
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;
            
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;
            
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;
            
            default:
                console.log(`Unhandled event type: ${event.type}`);
        }

        res.status(200).send('Webhook processed successfully');

    } catch (error) {
        console.error('Webhook signature verification failed:', error);
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }
});

/**
 * Handle successful checkout session completion
 * @param {Object} session - Stripe checkout session object
 */
async function handleCheckoutSessionCompleted(session) {
    console.log('Processing checkout.session.completed');
    
    const userId = session.metadata.userId;
    const priceType = session.metadata.priceType;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    if (!userId) {
        console.error('No userId found in session metadata');
        return;
    }

    try {
        // Get subscription details from Stripe
        const stripe = await getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        // Update user document in Firestore
        await db.collection('users').doc(userId).set({
            subscription: {
                status: 'active',
                plan: priceType === 'monthly' ? 'premium_monthly' : 'premium_annual',
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscriptionId,
                currentPeriodEnd: admin.firestore.Timestamp.fromDate(new Date(subscription.current_period_end * 1000)),
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            },
            features: {
                canAccessMealPlans: true,
                canAccessFullCookbook: true,
                savedRecipesLimit: -1, // -1 for unlimited
                canAccessChefPersonalities: true,
                canAccessIngredientsContext: true
            }
        }, { merge: true });

        console.log(`Successfully updated subscription for user: ${userId}`);

    } catch (error) {
        console.error('Error handling checkout.session.completed:', error);
        throw error;
    }
}

/**
 * Handle subscription updates (renewals, plan changes, etc.)
 * @param {Object} subscription - Stripe subscription object
 */
async function handleSubscriptionUpdated(subscription) {
    console.log('Processing customer.subscription.updated');
    
    const userId = subscription.metadata.userId;
    
    if (!userId) {
        console.error('No userId found in subscription metadata');
        return;
    }

    try {
        const isActive = subscription.status === 'active';
        
        await db.collection('users').doc(userId).set({
            subscription: {
                status: subscription.status,
                currentPeriodEnd: admin.firestore.Timestamp.fromDate(new Date(subscription.current_period_end * 1000)),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            features: {
                canAccessMealPlans: isActive,
                canAccessFullCookbook: isActive,
                savedRecipesLimit: isActive ? -1 : 3, // 3 for free tier, -1 for unlimited
                canAccessChefPersonalities: isActive,
                canAccessIngredientsContext: isActive
            }
        }, { merge: true });

        console.log(`Updated subscription status for user ${userId}: ${subscription.status}`);

    } catch (error) {
        console.error('Error handling customer.subscription.updated:', error);
        throw error;
    }
}

/**
 * Handle subscription cancellation
 * @param {Object} subscription - Stripe subscription object
 */
async function handleSubscriptionDeleted(subscription) {
    console.log('Processing customer.subscription.deleted');
    
    const userId = subscription.metadata.userId;
    
    if (!userId) {
        console.error('No userId found in subscription metadata');
        return;
    }

    try {
        await db.collection('users').doc(userId).set({
            subscription: {
                status: 'canceled',
                plan: 'free',
                canceledAt: admin.firestore.FieldValue.serverTimestamp()
            },
            features: {
                canAccessMealPlans: false,
                canAccessFullCookbook: false,
                savedRecipesLimit: 3, // Back to free tier limit (3 recipes)
                canAccessChefPersonalities: false,
                canAccessIngredientsContext: false
            }
        }, { merge: true });

        console.log(`Canceled subscription for user: ${userId}`);

    } catch (error) {
        console.error('Error handling customer.subscription.deleted:', error);
        throw error;
    }
}

/**
 * Handle failed payments
 * @param {Object} invoice - Stripe invoice object
 */
async function handlePaymentFailed(invoice) {
    console.log('Processing invoice.payment_failed');
    
    const customerId = invoice.customer;
    
    try {
        // Find user by Stripe customer ID
        const userQuery = await db.collection('users')
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();

        if (userQuery.empty) {
            console.error(`No user found for Stripe customer: ${customerId}`);
            return;
        }

        const userId = userQuery.docs[0].id;

        // Update subscription status to past_due
        await db.collection('users').doc(userId).set({
            subscription: {
                status: 'past_due',
                lastPaymentFailed: admin.firestore.FieldValue.serverTimestamp()
            }
        }, { merge: true });

        console.log(`Marked subscription as past_due for user: ${userId}`);

        // TODO: Trigger notification to user about failed payment

    } catch (error) {
        console.error('Error handling invoice.payment_failed:', error);
        throw error;
    }
} 