require('@shopify/shopify-api/adapters/node'); // Import the Node.js adapter
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { restResources } = require('@shopify/shopify-api/rest/admin/2023-10'); // Specify REST resources version

// Initialize Shopify API
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_draft_orders', 'read_draft_orders'],
  hostName: process.env.VERCEL_URL || 'localhost', // Use Vercel's host name or localhost
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
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
    const session = shopify.session.create({
      id: 'offline_session', // A unique ID for this session
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
      state: 'STATE_FROM_OAUTH_FLOW', // Placeholder
      isOnline: false, // Use offline token
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      scope: 'write_draft_orders,read_draft_orders',
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

    // Create a Draft Order
    const draftOrder = new restResources.DraftOrder({ session }); // Use restResources
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
    const completedOrder = await client.post({
      path: `draft_orders/${draftOrder.id}/complete`,
      data: {
        payment_pending: true,
      },
      type: 'application/json',
    });

    res.status(200).json({ success: true, orderId: completedOrder.body.order.id, orderNumber: completedOrder.body.order.order_number });

  } catch (error) {
    console.error('Error creating order:', error.response ? error.response.body : error);
    res.status(500).json({ success: false, message: 'Failed to create order.', error: error.message });
  }
};
