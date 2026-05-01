// backend.js - Core Shared Utility for AURACIOUS SIP API
require('dotenv').config();
const { admin, db } = require('./firebaseAdmin');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const cron = require('node-cron');

// 0. Environment Validation
const REQUIRED_ENV = [
    // Checks for either raw JSON or Base64 version
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ? 'FIREBASE_SERVICE_ACCOUNT_B64' : 'FIREBASE_SERVICE_ACCOUNT',
    'PAYSTACK_SECRET_KEY'
];

const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.error(`CRITICAL ERROR: Missing environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// 2. Shared Debugging & Verification Logger
const logVerification = async (reference, type, status, message) => {
    // Security: Filter sensitive data from logs
    const safeMessage = message ? message.replace(/(Bearer|sk_)\S+/gi, '[REDACTED]') : '';
    try {
        await db.ref('verificationLogs').push({
            reference: reference || 'N/A',
            type, 
            status, 
            message: safeMessage,
            timestamp: Date.now()
        });
    } catch (e) {
        console.error("Verification Logging failed:", e.message);
    }
};

// 3. Centralized Paystack Verification Engine
const verifyPaystack = async (reference) => {
    if (!reference) throw new Error("Transaction reference is required");

    // Strict sanitization of the reference string
    const sanitizedRef = encodeURIComponent(reference.trim().replace(/[\[\]\.\#\$]/g, ''));
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${sanitizedRef}`, {
        headers: { 
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Cache-Control': 'no-cache'
        },
        timeout: 10000
    });

    const data = response.data?.data;
    if (!data || data.status !== 'success') {
        throw new Error(data?.status ? `Gateway Status: ${data.status}` : "Invalid response from Paystack");
    }

    return {
        amountPaid: data.amount / 100, // Kobo to Naira
        raw: data
    };
};

// 4. Core Order Processing Logic
const processOrder = async (reference, orderData, amountPaid, isWebhook = false) => {
    await logVerification(reference, 'Order', 'Attempt', 'Processing order via core logic');

    const orderRef = db.ref('orders').push();
    const orderKey = orderRef.key;
    const ticketNumber = `AUS-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
    const now = Date.now();

    try {
        const result = await db.ref().transaction((currentData) => {
            if (currentData === null) return currentData;

            // 1. Idempotency Check: Ensure reference doesn't already exist in orders
            const orders = currentData.orders || {};
            const isDuplicate = Object.values(orders).some(o => o.paymentReference === reference);
            if (isDuplicate) return; // Abort transaction (it will return committed: false)

            // 2. Stock & Price Validation
            let expectedAmount = 0;
            const products = currentData.products || {};
            const verifiedItems = [];

            for (const item of orderData.items) {
                const p = products[item.id];
                if (!p || (p.stock || 0) < item.quantity) {
                    return; // Abort: Product missing or insufficient stock
                }
                const currentPrice = parseFloat(p.price);
                expectedAmount += currentPrice * item.quantity;
                verifiedItems.push({ ...item, price: currentPrice });
                
                // Deduct Stock
                p.stock -= item.quantity;
            }

            // 3. Amount Mismatch Validation
            if (Math.abs(amountPaid - expectedAmount) >= 0.01) return; 

            // 4. Construct Order and Update Analytics
            const newOrder = {
                customerName: orderData.customerName,
                email: orderData.email,
                phone: orderData.phone,
                address: orderData.address,
                note: orderData.note,
                items: verifiedItems,
                amount: amountPaid,
                ticketNumber: ticketNumber,
                orderStatus: 'Pending',
                paymentStatus: 'Paid',
                paymentReference: reference,
                createdAt: now
            };

            currentData.orders[orderKey] = newOrder;
            currentData.transactions = currentData.transactions || {};
            currentData.transactions[reference] = { status: 'Successful', amount: amountPaid, updatedAt: now };
            
            currentData.analytics = currentData.analytics || {};
            currentData.analytics.totalRevenue = (currentData.analytics.totalRevenue || 0) + amountPaid;
            currentData.analytics.successfulPayments = (currentData.analytics.successfulPayments || 0) + 1;

            return currentData;
        });

        if (!result.committed) {
            await logVerification(reference, 'Order', 'Failed', 'Transaction aborted: Stock, Amount, or Idempotency failure');
            throw new Error('Order verification failed or item out of stock.');
        }

        if (isWebhook) {
            await db.ref('devLogs').push({
                time: now,
                msg: `WEBHOOK RECOVERY: Successfully processed order ${reference}.`
            });
        }

        await logVerification(reference, 'Order', 'Success', 'Order verified and stock updated');
        return { success: true, message: 'Order processed successfully' };

    } catch (error) {
        console.error("Atomic Order Processing Error:", error.message);
        throw error;
    }
};

// 5. Core Subscription Processing Logic
const processSubscription = async (reference, months, amountPaid, frontendAmount, isWebhook = false) => {
    await logVerification(reference, 'Subscription', 'Attempt', 'Processing subscription via core logic');

    if (frontendAmount && amountPaid < (parseFloat(frontendAmount) - 0.05)) {
        await logVerification(reference, 'Subscription', 'Failed', `Amount mismatch: Paid ${amountPaid}, Expected ${frontendAmount}`);
        throw new Error('Amount mismatch');
    }

    const now = Date.now();
    const historyRef = db.ref('subscription/history').push();
    const historyKey = historyRef.key;

    try {
        const result = await db.ref().transaction((currentData) => {
            if (currentData === null) return currentData;

            // 1. Idempotency Check
            const history = currentData.subscription?.history || {};
            const isDuplicate = Object.values(history).some(h => h.reference === reference);
            if (isDuplicate) return; // Abort: Already processed

            // 2. Calculate New Expiry (Stacking logic)
            const sub = currentData.subscription || {};
            const baseDate = (sub.expiresAt && sub.expiresAt > now) ? sub.expiresAt : now;
            const newExpiry = baseDate + (months * 30 * 24 * 60 * 60 * 1000);

            // 3. Update Subscription State
            currentData.subscription = {
                ...sub,
                active: true,
                expiresAt: newExpiry,
                systemLocked: false,
                lastPaymentDate: now,
                updatedAt: now
            };

            // 4. Update History, Transactions, and Analytics
            currentData.subscription.history = currentData.subscription.history || {};
            currentData.subscription.history[historyKey] = { amount: amountPaid, months, date: now, reference, status: 'Successful' };
            
            currentData.transactions = currentData.transactions || {};
            currentData.transactions[reference] = { status: 'Successful', amount: amountPaid, updatedAt: now };
            
            currentData.analytics = currentData.analytics || {};
            currentData.analytics.monthlySales = (currentData.analytics.monthlySales || 0) + amountPaid;

            return currentData;
        });

        if (!result.committed) {
            await logVerification(reference, 'Subscription', 'Success', 'Idempotency: Subscription already updated');
            return { success: true, message: 'Subscription already updated' };
        }
    } catch (error) {
        console.error("Subscription Transaction Error:", error.message);
        throw error;
    }

    await db.ref('devLogs').push({ time: Date.now(), msg: `SYSTEM RESTORE: Subscription renewed via Paystack (Ref: ${reference}). Platform access extended for ${months} month(s).` });

    if (isWebhook) {
        await db.ref('devLogs').push({
            time: Date.now(),
            msg: `WEBHOOK RECOVERY: Successfully processed subscription for ${reference} which was missed by the frontend.`
        });
    }

    await logVerification(reference, 'Subscription', 'Success', 'Subscription processed successfully');
    return { success: true, expiresAt: newExpiry, message: 'Subscription processed successfully' };
};

// 5.5 Auto-Expiration CRON Job
// Runs every hour to check if the platform subscription has reached its end date.
// If expired, it sets 'active' to false to trigger the lock screen on the frontend.
cron.schedule('0 * * * *', async () => {
    try {
        const subRef = db.ref('subscription');
        const snapshot = await subRef.once('value');
        const sub = snapshot.val();

        if (sub && sub.active !== false && sub.expiresAt) {
            const now = Date.now();
            if (sub.expiresAt < now) {
                // Update the status to inactive
                await subRef.update({ 
                    active: false, 
                    updatedAt: admin.database.ServerValue.TIMESTAMP 
                });
                
                await db.ref('devLogs').push({
                    time: now,
                    msg: "AUTO-EXPIRY: Subscription period ended. Platform access is now restricted."
                });
                console.log('[CRON] Subscription expiry processed successfully.');
            }
        }
    } catch (error) {
        console.error('[CRON] Error during subscription expiry check:', error.message);
    }
});

// 6. Express Server Setup
const app = express();
app.use(express.json());
app.use(cors()); // Enables CORS for frontend domain

// Export Shared Resources BEFORE requiring routes to avoid circular dependency issues
module.exports = { admin, db, axios, PAYSTACK_SECRET_KEY, logVerification, verifyPaystack, processOrder, processSubscription, app };

// 7. Modular Routes
const { handleOrder } = require('./orders');
const { handleSubscription } = require('./subscription');
const { handleWebhook, handleManualVerification } = require('./verify-payment');

app.post('/api/orders', handleOrder);
app.use('/api/subscription', handleSubscription); // Handles POST and PATCH
app.post('/api/verify-payment', handleWebhook);
app.get('/api/verify-payment/:reference', handleManualVerification);

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        const snapshot = await db.ref('.info/serverTimeOffset').once('value');
        res.json({ status: 'online', service: 'AURACIOUS SIP API', firebase: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Basic Root Route for Health Check / Welcome
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Backend is running successfully"
  });
});

// Global 404 Handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found"
    });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error("Server Error:", err.stack);
    res.status(500).json({ success: false, message: "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`AURACIOUS SIP Backend Live on Port ${PORT}`);
});