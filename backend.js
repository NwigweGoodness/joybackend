// backend.js - Core Shared Utility for AURACIOUS SIP API
require('dotenv').config();
const path = require('path');
const { admin, db } = require(path.join(__dirname, 'firebaseAdmin'));
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

    const data = response.data.data;
    if (!data || data.status !== 'success') {
        throw new Error(data ? `Gateway Status: ${data.status}` : "Invalid response from Paystack");
    }

    return {
        amountPaid: data.amount / 100, // Kobo to Naira
        raw: data
    };
};

// 4. Core Order Processing Logic
const processOrder = async (reference, orderData, amountPaid, isWebhook = false) => {
    await logVerification(reference, 'Order', 'Attempt', 'Processing order via core logic');

    // Idempotency Check: Prevent duplicate orders for the same reference
    const existingOrderSnap = await db.ref('orders').orderByChild('paymentReference').equalTo(reference).limitToFirst(1).once('value');
    if (existingOrderSnap.exists()) {
        await logVerification(reference, 'Order', 'Success', 'Idempotency: Order already exists');
        let existingOrder;
        existingOrderSnap.forEach(c => { existingOrder = c.val(); });
        return { success: true, order: existingOrder, message: 'Order already processed' };
    }

    // Security: DB Price Lookup & Stock Pre-check
    const productRequests = orderData.items.map(item => db.ref(`products/${item.id}`).once('value'));
    const productSnapshots = await Promise.all(productRequests);
    
    // Map snapshots to IDs for reliable lookup
    const productMap = new Map();
    productSnapshots.forEach(snap => { if(snap.exists()) productMap.set(snap.key, snap.val()); });

    let expectedAmount = 0;
    const verifiedItems = [];

    for (const originalItem of orderData.items) {
        const product = productMap.get(originalItem.id);

        if (!product || (product.stock || 0) < originalItem.quantity) {
            await logVerification(reference, 'Order', 'Failed', `Stock error: ${originalItem.name}`);
            throw new Error(`Product unavailable or out of stock: ${originalItem.name}`);
        }

        const currentPrice = parseFloat(product.price);
        expectedAmount += currentPrice * originalItem.quantity;
        verifiedItems.push({ ...originalItem, price: currentPrice });
    }

    if (Math.abs(amountPaid - expectedAmount) >= 0.01) {
        await logVerification(reference, 'Order', 'Failed', `Amount mismatch: Paid ${amountPaid}, Expected ${expectedAmount}`);
        throw new Error(`Amount mismatch: Paid ${amountPaid}, Expected ${expectedAmount}`);
    }

    // Atomic Stock Deduction
    const stockDeductions = verifiedItems.map(item => {
        return db.ref(`products/${item.id}/stock`).transaction(currentStock => {
            if (currentStock !== null && currentStock >= item.quantity) {
                return currentStock - item.quantity;
            }
            return; // Abort transaction if stock became insufficient
        });
    });

    const deductionResults = await Promise.all(stockDeductions);
    if (deductionResults.some(r => !r.committed)) {
        await logVerification(reference, 'Order', 'Failed', 'Atomic stock update conflict');
        throw new Error('Stock update conflict: One or more items became unavailable.');
    }

    const ticketNumber = `AUS-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

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
        createdAt: admin.database.ServerValue.TIMESTAMP
    };

    const orderRef = db.ref('orders').push();
    await orderRef.set(newOrder);

    await db.ref(`transactions/${reference}`).update({ 
        status: 'Successful', 
        amount: amountPaid, 
        updatedAt: admin.database.ServerValue.TIMESTAMP 
    });
    await db.ref('analytics/totalRevenue').transaction(c => (c || 0) + amountPaid);
    await db.ref('analytics/successfulPayments').transaction(c => (c || 0) + 1);

    if (isWebhook) {
        await db.ref('devLogs').push({
            time: Date.now(),
            msg: `WEBHOOK RECOVERY: Successfully processed order for ${reference} which was missed by the frontend.`
        });
    }

    await logVerification(reference, 'Order', 'Success', 'Order verified and stock updated');
    return { success: true, order: newOrder, message: 'Order processed successfully' };
};

// 5. Core Subscription Processing Logic
const processSubscription = async (reference, months, amountPaid, frontendAmount, isWebhook = false) => {
    await logVerification(reference, 'Subscription', 'Attempt', 'Processing subscription via core logic');

    // Idempotency Check
    const historySnap = await db.ref('subscription/history').orderByChild('reference').equalTo(reference).limitToFirst(1).once('value');
    if (historySnap.exists()) {
        await logVerification(reference, 'Subscription', 'Success', 'Idempotency: Subscription already updated');
        return { success: true, message: 'Subscription already updated' };
    }

    if (frontendAmount && amountPaid < (parseFloat(frontendAmount) - 0.05)) {
        await logVerification(reference, 'Subscription', 'Failed', `Amount mismatch: Paid ${amountPaid}, Expected ${frontendAmount}`);
        throw new Error('Amount mismatch');
    }

    const subRef = db.ref('subscription');
    const snapshot = await subRef.once('value');
    const currentSub = snapshot.val() || { expiresAt: Date.now() };

    const baseDate = (currentSub.expiresAt && currentSub.expiresAt > Date.now()) ? currentSub.expiresAt : Date.now();
    const newExpiry = baseDate + (months * 30 * 24 * 60 * 60 * 1000);

    await subRef.update({ active: true, expiresAt: newExpiry, systemLocked: false, lastPaymentDate: Date.now(), updatedAt: admin.database.ServerValue.TIMESTAMP });
    await db.ref('subscription/history').push({ amount: amountPaid, months: months, date: Date.now(), reference: reference, status: 'Successful' });
    await db.ref('analytics/monthlySales').transaction(c => (c || 0) + amountPaid);
    
    await db.ref(`transactions/${reference}`).update({ 
        status: 'Successful', 
        amount: amountPaid, 
        updatedAt: admin.database.ServerValue.TIMESTAMP 
    });

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
const { handleOrder } = require('orders');
const { handleSubscription } = require('subscription');
const { handleWebhook, handleManualVerification } = require('verify-payment');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`AURACIOUS SIP Backend Live on Port ${PORT}`);
});