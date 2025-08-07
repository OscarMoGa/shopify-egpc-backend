require('@shopify/shopify-api/adapters/node');
const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api');

// Initialize Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_draft_orders', 'read_draft_orders', 'read_products'],
  hostName: process.env.VERCEL_URL || 'localhost',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

module.exports = async (req, res) => {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*'); // For production, replace '*' with your Shopify domain
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).send();
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const { variantId, customer, shippingAddress } = req.body;

    if (!variantId || !customer || !shippingAddress) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const session = new Session({
      id: 'offline_session',
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
      state: 'STATE_FROM_OAUTH_FLOW',
      isOnline: false,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      scope: 'write_draft_orders,read_draft_orders,read_products',
    });

    const client = new shopify.clients.Rest({ session });

    // Step 1: Fetch product variant details
    const productVariantResponse = await client.get({
      path: `variants/${variantId}`,
    });

    if (!productVariantResponse || !productVariantResponse.body || !productVariantResponse.body.variant) {
      return res.status(404).json({ success: false, message: 'Product variant not found.' });
    }

    const variant = productVariantResponse.body.variant;

    // Step 2: Create the Draft Order using the correct REST client method
    const draftOrderPayload = {
      draft_order: {
        line_items: [
          {
            variant_id: variant.id,
            quantity: 1,
            // Price and title are usually not needed here as they are fetched from the variant_id
          },
        ],
        customer: {
          first_name: customer.name.split(' ')[0] || '',
          last_name: customer.name.split(' ').slice(1).join(' ') || '',
          email: customer.email,
          phone: customer.phone,
        },
        shipping_address: {
          address1: shippingAddress.address1,
          city: shippingAddress.city,
          province: shippingAddress.province,
          country: shippingAddress.country,
          zip: shippingAddress.zip,
          first_name: customer.name.split(' ')[0] || '',
          last_name: customer.name.split(' ').slice(1).join(' ') || '',
          phone: customer.phone,
        },
        use_customer_default_address: false,
        tags: 'EGPC',
        note: 'Pedido generado por formulario EGPC (Pago Contra Entrega)',
        send_receipt: false,
      }
    };

    const createDraftOrderResponse = await client.post({
      path: 'draft_orders',
      data: draftOrderPayload,
      type: 'application/json',
    });

    const draftOrder = createDraftOrderResponse.body.draft_order;

    // Step 3: Mark as paid and complete the order (for COD)
    let completedOrderResponse;
    try {
      completedOrderResponse = await client.put({ // Use PUT to complete a draft order
        path: `draft_orders/${draftOrder.id}/complete`,
        data: {
          payment_pending: true
        },
        type: 'application/json',
      });
    } catch (completeError) {
      if (completeError.response && (completeError.response.status === 200 || completeError.response.status === 202)) {
         console.warn('Warning: Draft order complete endpoint returned a non-JSON success response. Assuming success.');
         // The draft order is now a real order, we need to get the order ID from the draft order itself
         const completedDraftOrderResponse = await client.get({ path: `draft_orders/${draftOrder.id}` });
         const orderId = completedDraftOrderResponse.body.draft_order.order_id;
         return res.status(200).json({ success: true, message: 'Order created and completed (response parsing warning).', orderId: orderId });
      }
      throw completeError;
    }
    
    const finalOrder = completedOrderResponse.body.draft_order;

    res.status(200).json({ success: true, orderId: finalOrder.order_id, orderNumber: finalOrder.name });

  } catch (error) {
    console.error('Error creating order:', error.response ? JSON.stringify(error.response.body, null, 2) : error);
    res.status(500).json({ success: false, message: 'Failed to create order.', error: error.message });
  }
};