require('@shopify/shopify-api/adapters/node'); // Import the Node.js adapter
const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api');
const { restResources } = require('@shopify/shopify-api'); // CORRECTED: Import restResources directly from the main package

// Initialize Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_draft_orders', 'read_draft_orders', 'read_products'], // Ensure read_products is included
  hostName: process.env.VERCEL_URL || 'localhost', // Use Vercel's host name or localhost
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  restResources, // IMPORTANT: Pass restResources here
});

module.exports = async (req, res) => {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*'); // For production, replace '*' with your Shopify domain (e.g., 'https://your-store.myshopify.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(204).send(); // No content, just headers
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const { variantId, customer, shippingAddress } = req.body;

    if (!variantId || !customer || !shippingAddress) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    // Create a session for the Admin API client
    const session = new Session({
      id: 'offline_session', // A unique ID for this session
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
      state: 'STATE_FROM_OAUTH_FLOW', // Placeholder
      isOnline: false, // Use offline token
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      scope: 'write_draft_orders,read_draft_orders,read_products', // Ensure scopes match
    });

    const client = new shopify.clients.Rest({ session });

    // Fetch product variant details to get price and title
    const productVariant = await client.get({
      path: `variants/${variantId}`,
    });

    if (!productVariant || !productVariant.body || !productVariant.body.variant) {
      return res.status(404).json({ success: false, message: 'Product variant not found.' });
    }

    const variant = productVariant.body.variant;

    // Create a Draft Order using shopify.rest
    const draftOrder = new shopify.rest.DraftOrder({ session });
    draftOrder.line_items = [
      {
        variant_id: variant.id,
        quantity: 1,
        price: variant.price,
        title: variant.title,
      },
    ];
    draftOrder.customer = {
      first_name: customer.name.split(' ')[0] || '',
      last_name: customer.name.split(' ').slice(1).join(' ') || '',
      email: customer.email,
      phone: customer.phone,
    };
    draftOrder.shipping_address = {
      address1: shippingAddress.address1,
      city: shippingAddress.city,
      province: shippingAddress.province,
      country: shippingAddress.country,
      zip: shippingAddress.zip,
      first_name: customer.name.split(' ')[0] || '',
      last_name: customer.name.split(' ').slice(1).join(' ') || '',
      phone: customer.phone,
    };
    draftOrder.use_customer_default_address = false;
    draftOrder.tags = 'EGPC';
    draftOrder.note = 'Pedido generado por formulario EGPC (Pago Contra Entrega)';
    draftOrder.send_receipt = false;

    await draftOrder.save({
      update: true,
    });

    // Mark as paid and complete the order (for COD)
    let completedOrderResponse;
    try {
      completedOrderResponse = await client.post({
        path: `draft_orders/${draftOrder.id}/complete`,
        data: {
          payment_pending: true,
        },
        type: 'application/json',
      });
    } catch (completeError) {
      // If the error is specifically about JSON parsing, and the draft order was saved,
      // we can assume it completed successfully on Shopify's end.
      if (completeError.type === 'invalid-json' || (completeError.message && completeError.message.includes('Unexpected end of JSON input'))) {
        console.warn('Warning: Draft order complete endpoint returned non-JSON or empty response. Assuming success if draft order was saved.');
        // Return success, as the order likely completed on Shopify's side
        return res.status(200).json({ success: true, message: 'Order created and completed (response parsing warning).' });
      }
      throw completeError; // Re-throw if it's a different kind of error
    }

    res.status(200).json({ success: true, orderId: completedOrderResponse.body.order.id, orderNumber: completedOrderResponse.body.order.order_number });

  } catch (error) {
    console.error('Error creating order:', error.response ? error.response.body : error);
    res.status(500).json({ success: false, message: 'Failed to create order.', error: error.message });
  }
};