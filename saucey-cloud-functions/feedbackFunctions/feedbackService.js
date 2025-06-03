// saucey-cloud-functions/feedbackFunctions/feedbackService.js

// Gen 2 specific import for scheduled functions
const { onSchedule } = require('firebase-functions/v2/scheduler'); // For scheduled functions
const { logger } = require('firebase-functions/v2'); // Use the v2 logger
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { generateContent: generateGeminiContent } = require('@saucey/shared/services/geminiClient.js'); // Assuming HarmCategory, HarmBlockThreshold are not directly used here or handled within generateGeminiContent
const feedbackConfig = require('./config'); // feedbackConfig.js content will be used here
const firestoreHelper = require('@saucey/shared/services/firestoreHelper');
const { Timestamp } = firestoreHelper; // Assuming Timestamp is correctly from firestoreHelper

const secretManagerClient = new SecretManagerServiceClient();

// Firebase Admin SDK initialization (idempotent)
if (admin.apps.length === 0) {
  admin.initializeApp();
}
const db = admin.firestore();

let mailTransport;

// Nodemailer initialization (no change needed in this function itself)
async function initializeNodemailer() {
  if (mailTransport) return;

  const gmailEmail = feedbackConfig.GMAIL_SENDER_EMAIL;
  const recipientEmail = feedbackConfig.FEEDBACK_RECIPIENT_EMAIL;

  if (!gmailEmail) {
    logger.error('Gmail sending email (GMAIL_SENDER_EMAIL env var) is not set. Email sending will be disabled.');
    return;
  }
  if (!recipientEmail) {
    logger.warn('Recipient email (FEEDBACK_RECIPIENT_EMAIL env var) is not set or using default.');
  }

  let gmailPassword;
  try {
    // Standardize project ID fetching - Prefer environment variable, then config, then fallback.
    const projectID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || feedbackConfig.PROJECT_ID || 'saucey-3fb0f';
    if (!projectID) {
      throw new Error('Google Cloud Project ID not found in environment variables or config.');
    }
    const secretName = `projects/${projectID}/secrets/${feedbackConfig.GMAIL_APP_PASSWORD_SECRET_ID}/versions/${feedbackConfig.GMAIL_APP_PASSWORD_SECRET_VERSION}`;
    const [version] = await secretManagerClient.accessSecretVersion({ name: secretName });
    gmailPassword = version.payload.data.toString('utf8');
    if (!gmailPassword) {
      throw new Error('Fetched Gmail App Password from Secret Manager is empty.');
    }
    logger.info('Successfully fetched Gmail App Password from Secret Manager for feedback service.');
  } catch (error) {
    logger.error('CRITICAL: Failed to fetch Gmail App Password from Secret Manager for feedback service:', { errorMessage: error.message, stack: error.stack });
    return; // Stop if password fetch fails
  }

  if (gmailPassword) {
    mailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailEmail,
        pass: gmailPassword,
      },
    });
    logger.info('Nodemailer transport configured using password from Secret Manager.');
  } else {
    logger.error('Gmail password was not available. Email sending disabled.');
  }
}

const nodemailerInitializationPromise = initializeNodemailer();


// LLM Summary function (no change needed in this function itself)
async function getLlmSummary(feedbackEntries) {
  if (feedbackEntries.length === 0) {
    return 'No new feedback to summarize in the monitored period.';
  }
  // ... (rest of your getLlmSummary function, ensure logger calls are updated to logger.log, logger.error etc.)
  // Make sure to use logger.log, logger.warn, logger.error from firebase-functions/v2
  // Example: logger.log("Sending prompt...");
  const projectID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || feedbackConfig.PROJECT_ID || 'saucey-3fb0f';
  const promptText = `
    You are an AI assistant for the Saucey recipe app. Your project ID is '${projectID}'.
    Please summarize the following user feedback entries.
    Focus on identifying common themes, critical bugs (especially those preventing app usage or causing crashes),
    highly requested features, and overall user sentiment.
    Organize the summary clearly with the following sections:
    - Overall Sentiment Summary (e.g., mostly positive, mixed with concerns about X, primarily feature requests):
    - Critical Bugs & Usability Issues:
    - Top Feature Requests:
    - UI/UX & General Comments:
    - Positive Feedback Snippets:
    For each theme or significant item, provide 1-2 anonymized quotes or paraphrased examples from the feedback to illustrate the point.
    Keep the summary concise but informative.

    Feedback entries:
    ${feedbackEntries.map((entry, index) => `
      Entry ${index + 1}:
      User: ${entry.username || entry.userId || 'Anonymous'} (Email: ${entry.email || 'N/A'})
      Type: ${entry.feedbackType || 'N/A'}
      Affected Feature: ${entry.affectedFeature || 'N/A'}
      Description: ${entry.description || 'N/A'}
      App Version: ${entry.appVersion || 'N/A'} (Build: ${entry.buildNumber || 'N/A'})
      Device: ${entry.deviceModel || 'N/A'}, OS: ${entry.osVersion || 'N/A'}
      Screenshots: ${entry.screenshotURLs && entry.screenshotURLs.length > 0 ? `${entry.screenshotURLs.length} attached` : 'None'}
      Date: ${entry.timestamp && entry.timestamp.toDate ? entry.timestamp.toDate().toLocaleDateString() : 'N/A'}
      Status: ${entry.status || 'N/A'}
    `).join('\n---------------------------------------------------\n')}
  `;

  logger.info('Sending prompt for feedback summary via shared Gemini client (first 500 chars):', { promptStart: promptText.substring(0, 500) + '...' });

  try {
    const generationConfig = {
      temperature: 0.3,
      topK: 32,
      topP: 1,
      maxOutputTokens: 6144, // Consider if this needs to be higher for some summaries
    };

    const response = await generateGeminiContent({
      modelName: feedbackConfig.GEMINI_MODEL_NAME_FOR_SUMMARY,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      generationConfig,
    });
    
    // Assuming response.text() is the correct way to get text from your shared geminiClient
    // If generateGeminiContent returns a structure like { text: () => "summary" }
    const summaryText = typeof response.text === 'function' ? response.text() : response; 

    logger.info('Gemini feedback summary received via shared client (first 200 chars):', { summaryStart: String(summaryText).substring(0, 200) + '...' });
    return String(summaryText);

  } catch (error) {
    logger.error('Error calling shared Gemini client for feedback summary:', { errorMessage: error.message, stack: error.stack });
    let errorMessageText = 'Error generating summary from LLM via shared client.';
    if (error.message && error.message.toLowerCase().includes('safety')) {
      errorMessageText = `Request or generated response for feedback summary was blocked due to safety settings. Details: ${error.message}`;
    } else if (error.message) {
      errorMessageText += ` Details: ${error.message}`;
    }
    return errorMessageText;
  }
}

// --- Gen 2 Function ---
// It's good practice to give V2 functions a new name during migration to avoid conflicts,
// or ensure your deployment strategy handles replacement correctly.
exports.summarizeAndReportFeedbackV2 = onSchedule(
  {
    schedule: feedbackConfig.FEEDBACK_SUMMARY_SCHEDULE, // From your config.js
    timeZone: 'America/Los_Angeles',
    // Runtime options for Gen 2:
    cpu: 1, // Specify CPU (e.g., 1, 2, 4). Default is 1 for Gen 2. Can also be "gcf_gen1" to mimic Gen1 CPU behavior
    memory: '512MiB', // Specify memory (e.g., "256MiB", "512MiB", "1GiB", "2GiB")
    timeoutSeconds: 300, // Max 540 for scheduled functions
    // region: "us-central1", // Optional: specify region if needed
    // secrets: [feedbackConfig.GMAIL_APP_PASSWORD_SECRET_ID], // If you manage secrets this way for v2
  },
  async (event) => { // event argument is standard for v2 scheduled functions
    await nodemailerInitializationPromise;
    logger.log('Running summarizeAndReportFeedbackV2 (Gen 2) function. Event ID:', event.id);

    const recipientEmail = feedbackConfig.FEEDBACK_RECIPIENT_EMAIL;
    const gmailEmail = feedbackConfig.GMAIL_SENDER_EMAIL;

    if (!mailTransport) {
      logger.error('Nodemailer transport not configured. Cannot send email.');
      return; // Using return instead of return null for clarity
    }
    if (!recipientEmail || !gmailEmail) {
      logger.error('Sender or Recipient email not configured. Cannot send email.');
      return;
    }

    const periodDays = feedbackConfig.FEEDBACK_SUMMARY_PERIOD_DAYS;
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - periodDays);
    const lookbackTimestamp = Timestamp.fromDate(lookbackDate);

    let feedbackItems = [];
    try {
      await firestoreHelper.ensureFirestoreInitialized();
      const queryOptions = {
        where: [{ field: 'timestamp', operator: '>=', value: lookbackTimestamp }],
        orderBy: [{ field: 'timestamp', direction: 'desc' }]
      };
      feedbackItems = await firestoreHelper.getCollection(feedbackConfig.FEEDBACK_COLLECTION_NAME, queryOptions);
      
      const reportDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const projectID = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || feedbackConfig.PROJECT_ID || 'saucey-3fb0f'; // [!] feedbackConfig.js defines PROJECT_ID
      const subject = `Saucey App - Feedback Report (${periodDays}-day period ending ${reportDate})`;


      if (feedbackItems.length === 0) {
        logger.log(`No feedback submissions in the last ${periodDays} days.`);
        const mailOptions = {
          from: `"Saucey App Feedback" <${gmailEmail}>`,
          to: recipientEmail,
          subject: subject,
          text: `No new feedback was submitted in the Saucey app during the past ${periodDays} days.`,
          html: `<p>No new feedback was submitted in the Saucey app during the past ${periodDays} days (for period ending ${reportDate}).</p>`,
        };
        await mailTransport.sendMail(mailOptions);
        logger.log(`Empty feedback report email sent for ${periodDays}-day period.`);
        return;
      }

      const llmSummary = await getLlmSummary(feedbackItems);

      const mailOptions = {
        from: `"Saucey App Feedback" <${gmailEmail}>`,
        to: recipientEmail,
        subject: subject,
        text: `There were ${feedbackItems.length} new feedback submission(s) during the past ${periodDays} days.\n\nFeedback Summary for Saucey App (Project ID: ${projectID} - Period: Last ${periodDays} Days):\n\n${llmSummary}`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6;">
            <h1>Feedback Summary - Saucey App</h1>
            <p><strong>Project ID:</strong> ${projectID}</p>
            <p><strong>Report for ${periodDays}-day period ending:</strong> ${reportDate}</p>
            <p><strong>There were ${feedbackItems.length} new feedback submission(s) during this ${periodDays}-day period.</strong></p>
            <hr>
            <h2 style="color: #333;">AI Generated Summary:</h2>
            <pre style="white-space: pre-wrap; font-family: Consolas, 'Courier New', monospace; font-size: 14px; background-color: #f9f9f9; padding: 15px; border-radius: 5px; border: 1px solid #eee;">${llmSummary}</pre>
            <hr>
            <p><strong>Total feedback entries analyzed this period:</strong> ${feedbackItems.length}</p>
            <p><em>This is an automated report.</em></p>
          </div>
        `,
      };
      await mailTransport.sendMail(mailOptions);
      logger.log('Feedback summary email sent to:', recipientEmail);

    } catch (error) {
      logger.error('Error in summarizeAndReportFeedbackV2 function:', error.message, error.stack);
      if (mailTransport) {
        try {
          await mailTransport.sendMail({
            from: `"Saucey App Feedback ERROR" <${gmailEmail}>`,
            to: recipientEmail,
            subject: `URGENT: Saucey App - Feedback Report FAILED (${new Date().toLocaleDateString()})`,
            text: `The feedback summary function (V2) encountered an error: ${error instanceof Error ? error.message : String(error)} \n\nStack: ${error instanceof Error ? error.stack : 'N/A'}`,
          });
        } catch (emailError) {
          logger.error('Error sending failure email:', emailError);
        }
      }
    }
  }
);

// --- Gen 2 Function ---
exports.cleanupOldFeedbackV2 = onSchedule(
  {
    schedule: feedbackConfig.FEEDBACK_CLEANUP_SCHEDULE, // From your config.js
    timeZone: 'America/Los_Angeles',
    // Runtime options for Gen 2:
    cpu: 1, 
    memory: '256MiB', // Usually cleanup doesn't need much memory
    timeoutSeconds: 540, // Max 540 for scheduled functions
    // region: "us-central1", // Optional: specify region if needed
  },
  async (event) => {
    await nodemailerInitializationPromise; // For error reporting
    logger.log('Running cleanupOldFeedbackV2 (Gen 2) function. Event ID:', event.id);

    const retentionDays = feedbackConfig.FEEDBACK_RETENTION_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffTimestamp = Timestamp.fromDate(cutoffDate);

    logger.log(`Deleting feedback older than ${retentionDays} days (before ${cutoffDate.toISOString()}).`);
    const gmailEmail = feedbackConfig.GMAIL_SENDER_EMAIL;
    const recipientEmail = feedbackConfig.FEEDBACK_RECIPIENT_EMAIL;

    try {
      await firestoreHelper.ensureFirestoreInitialized();
      const feedbackCollectionRef = db.collection(feedbackConfig.FEEDBACK_COLLECTION_NAME);
      const query = feedbackCollectionRef.where('timestamp', '<', cutoffTimestamp);

      const snapshot = await query.get();
      if (snapshot.empty) {
        logger.log('No old feedback found to delete.');
        return;
      }

      // Batch delete (Firestore limits batch writes to 500 operations)
      const batchArray = [];
      batchArray.push(db.batch());
      let operationCounter = 0;
      let batchIndex = 0;

      snapshot.docs.forEach(doc => {
        batchArray[batchIndex].delete(doc.ref);
        operationCounter++;
        if (operationCounter >= 499) { // Leave a little room
          batchArray.push(db.batch());
          batchIndex++;
          operationCounter = 0;
        }
      });

      await Promise.all(batchArray.map(batch => batch.commit()));
      logger.log(`Successfully deleted ${snapshot.size} old feedback documents.`);

    } catch (error) {
      logger.error('Error in cleanupOldFeedbackV2 function:', error.message, error.stack);
      if (mailTransport && recipientEmail && gmailEmail) {
        try {
          await mailTransport.sendMail({
            from: `"Saucey App System ERROR" <${gmailEmail}>`,
            to: recipientEmail,
            subject: 'URGENT: Saucey App - Old Feedback Cleanup FAILED (V2)',
            text: `The cleanupOldFeedback function (V2) encountered an error: ${error.message}\n\nStack: ${error.stack}`,
          });
        } catch (emailError) {
          logger.error('Error sending cleanup failure email:', emailError);
        }
      }
    }
  }
);

