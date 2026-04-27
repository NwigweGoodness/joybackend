// backend.js - Core Shared Utility for AURACIOUS SIP API
require('dotenv').config();
const admin = require('firebase-admin');
const axios = require('axios');
const express = require('express');
const cors = require('cors');

// 1. Safe Firebase Initialization (Idempotent)
if (!admin.apps.length) {
    try {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
        }
        
        // Parse the service account from an environment variable string
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        
        // Fix for private key newlines: replace escaped \n with real newlines
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL || "https://audacious-sip-default-rtdb.firebaseio.com/"
        });
        // Enable keep-alive for faster serverless execution
        admin.database().getRules(); 
        console.log("Firebase Admin Initialized Successfully");
    } catch (error) {
        console.error("CRITICAL: Firebase Admin Init Failed. Ensure FIREBASE_SERVICE_ACCOUNT is a valid JSON string:", error.message);
        process.exit(1); // Stop the process so Render knows the deploy failed
    }
}
const db = admin.database(); // Now safe to call
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// 2. Shared Debugging & Verification Logger
const logVerification = async (reference, type, status, message) => {
    try {
        await db.ref('verificationLogs').push({
            reference: reference || 'N/A',
            type, 
            status, 
            message,
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
        timeout: 10000 // 10 second timeout to prevent Vercel execution hang
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
    const existingOrderSnap = await db.ref('orders').orderByChild('paymentReference').equalTo(reference).once('value');
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
    const historySnap = await db.ref('subscription/history').orderByChild('reference').equalTo(reference).once('value');
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

// 6. Express Server Implementation for Render Deployment
const app = express();
app.use(express.json());
app.use(cors()); // Enables CORS for frontend domain

// Health Check
app.get('/api/health', (req, res) => res.json({ status: 'online', service: 'AURACIOUS SIP API' }));

/**
 * Route: /api/orders
 * Handles order verification and stock deduction
 */
app.post('/api/orders', async (req, res) => {
    let { reference, orderData } = req.body;
    try {
        if (!reference) throw new Error("Reference is required for verification.");

        // Recovery Logic: If orderData is missing, reconstruct from transaction ledger
        if (!orderData) {
            const transSnap = await db.ref(`transactions/${reference}`).once('value');
            if (transSnap.exists()) {
                const trans = transSnap.val();
                orderData = {
                    customerName: trans.customerName,
                    email: trans.email,
                    phone: trans.phone,
                    address: trans.address,
                    note: trans.note || "",
                    items: trans.items
                };
            }
        }

        if (!orderData || !orderData.items) throw new Error("Order data could not be recovered. Please contact support.");

        const { amountPaid } = await verifyPaystack(reference);
        const result = await processOrder(reference, orderData, amountPaid);
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * Route: /api/subscription
 * Handles subscription renewals and Tinubu panel price updates
 */
app.post('/api/subscription', async (req, res) => {
    const { reference, months, amount: frontendAmount } = req.body;
    try {
        const { amountPaid } = await verifyPaystack(reference);
        const result = await processSubscription(reference, months, amountPaid, frontendAmount);
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.patch('/api/subscription', async (req, res) => {
    const { monthlyPrice, grace } = req.body;
    try {
        await db.ref('subscriptionPricing').update({ monthlyPrice, grace, updatedAt: Date.now() });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * Route: /api/verify-payment
 * Paystack Webhook Listener
 */
app.post('/api/verify-payment', async (req, res) => {
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Invalid Signature');

    const event = req.body;
    if (event.event === 'charge.success') {
        const reference = event.data.reference;
        try {
            const { amountPaid } = await verifyPaystack(reference);
            const transSnap = await db.ref(`transactions/${reference}`).once('value');
            const trans = transSnap.val();

            if (!trans) {
                await logVerification(reference, 'Webhook', 'Warning', 'Transaction record missing in database.');
                return res.status(200).send('Webhook Received (No record found)');
            }

            // Identify between Order and Subscription based on properties
            if (trans.items) {
                await processOrder(reference, trans, amountPaid, true);
            } else if (trans.months) {
                await processSubscription(reference, trans.months, amountPaid, trans.amount, true);
            } else {
                await logVerification(reference, 'Webhook', 'Error', 'Unknown transaction type (neither items nor months found).');
            }
            res.status(200).send('Webhook Processed');
        } catch (e) {
            res.status(500).send(e.message);
        }
    } else {
        res.status(200).send('Event Ignored');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AURACIOUS SIP Backend Live on Port ${PORT}`);
});

// Export Shared Resources
module.exports = { admin, db, axios, PAYSTACK_SECRET_KEY, logVerification, verifyPaystack, processOrder, processSubscription, app };