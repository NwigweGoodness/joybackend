// api/verify-payment.js - Paystack Webhook Listener & Redundant Transaction Coverage
const 
const handleWebhook = async (req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Webhooks must be POST requests.' });

    // 1. Verify Paystack Webhook Signature (Security Critical)
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
        await logVerification('N/A', 'Webhook', 'Failed', 'Invalid Paystack signature');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // 2. Extract Reference from Webhook Payload
    const event = req.body;
    const reference = event.data?.reference;
    const eventType = event.event;

    if (!reference) {
        await logVerification('N/A', 'Webhook', 'Failed', `Missing reference in event: ${eventType}`);
        return res.status(400).json({ success: false, message: 'Reference missing in webhook payload' });
    }

    await logVerification(reference, 'Webhook', 'Received', `Event: ${eventType}`);

    try {
        // Only process successful charge events
        if (eventType === 'charge.success') {
            // 3. Verify transaction with Paystack (redundant but good practice for webhooks)
            const { amountPaid } = await verifyPaystack(reference);

            // 4. Retrieve original transaction details from Firebase
            const originalTransSnap = await db.ref(`transactions/${reference}`).once('value');
            const originalTransData = originalTransSnap.val();

            if (!originalTransData) {
                await logVerification(reference, 'Webhook', 'Warning', 'Original transaction data not found in DB. Cannot process order/subscription.');
                return res.status(200).json({ success: true, message: 'Transaction data not found, no action taken.' });
            }

            // Dispatch to appropriate processing logic based on original transaction type
            if (originalTransData.items) { // This indicates an order
                const orderData = {
                    customerName: originalTransData.customerName,
                    email: originalTransData.email,
                    phone: originalTransData.phone,
                    address: originalTransData.address,
                    note: originalTransData.note,
                    items: originalTransData.items // Assuming items are stored in pending transaction
                };
                 const result = await processOrder(reference, orderData, amountPaid, true);
                return res.status(200).json(result);
            } else if (originalTransData.months) { // This indicates a subscription
                const result = await processSubscription(reference, originalTransData.months, amountPaid, originalTransData.amount, true);
                return res.status(200).json(result);
            } else {
                await logVerification(reference, 'Webhook', 'Warning', 'Unknown transaction type. No order/subscription processed.');
                return res.status(200).json({ success: true, message: 'Unknown transaction type, no action taken.' });
            }
        } else {
            await logVerification(reference, 'Webhook', 'Ignored', `Event type: ${eventType}`);
            return res.status(200).json({ success: true, message: 'Webhook event not processed' });
        }
    } catch (error) {
        await logVerification(reference, 'Webhook', 'Error', error.message);
        return res.status(500).json({ 
            success: false, 
            message: `Internal Server Error: ${error.message}` 
        });
    }
};

module.exports = { handleWebhook };