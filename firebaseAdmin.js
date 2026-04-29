// firebaseAdmin.js - Secure Firebase Configuration Module
const admin = require('firebase-admin');

/**
 * Prevents double initialization which often causes errors during 
 * development hot-reloads.
 */
if (!admin.apps.length) {
    try {
        let serviceAccount;
        const b64Config = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
        const rawConfig = process.env.FIREBASE_SERVICE_ACCOUNT;

        // 1. Parse Credentials
        if (b64Config) {
            const decoded = Buffer.from(b64Config.trim(), 'base64').toString('utf8');
            serviceAccount = JSON.parse(decoded);
        } else if (rawConfig) {
            let cleanedJson = rawConfig.trim().replace(/\n/g, '\\n').replace(/\r/g, '\\r');
            cleanedJson = cleanedJson.replace(/(?<!\\)\\(?!["\\\/bfnrtu])/g, "\\\\");
            serviceAccount = JSON.parse(cleanedJson);
        } else {
            // Fallback to individual variables if JSON isn't provided
            serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY
            };
        }

        // 2. Global PEM Sanitizer
        if (serviceAccount.private_key || serviceAccount.privateKey) {
            let key = (serviceAccount.private_key || serviceAccount.privateKey).trim();
            key = key.replace(/\\n/g, '\n');
            const header = '-----BEGIN PRIVATE KEY-----';
            const footer = '-----END PRIVATE KEY-----';
            
            if (key.includes(header) && key.includes(footer)) {
                const body = key.split(header)[1].split(footer)[0].replace(/\s+/g, '');
                key = `${header}\n${body}\n${footer}\n`;
            }
            if (serviceAccount.private_key) serviceAccount.private_key = key;
            else serviceAccount.privateKey = key;
        }

        // 3. Initialize SDK
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL || "https://audacious-sip-default-rtdb.firebaseio.com/"
        });

        console.log("Firebase Admin Initialized Successfully");
    } catch (error) {
        console.error("*****************************************");
        console.error("CRITICAL: Firebase Admin initialization failed");
        console.error("Error Detail:", error.message);
        console.error("*****************************************");
        process.exit(1); // Force exit to prevent running in an unstable state
    }
}

// Export instances for use throughout the application
const db = admin.database();
const auth = admin.auth();

module.exports = { admin, db, auth };