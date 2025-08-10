require('@shopify/shopify-api/adapters/node');
const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api');

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_draft_orders', 'read_draft_orders', 'read_products'],
  hostName: process.env.VERCEL_URL || 'localhost',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

// CORS Middleware
const allowCors = fn => async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // O especifica tu dominio: 'https://your-shop-domain.com'
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  return await fn(req, res);
};

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // El cuerpo de la petición ahora es texto plano, necesitamos parsearlo
    const body = JSON.parse(req.body);
    const { line_items, customer, shippingAddress, total_price } = body;

    if (!line_items || !customer || !shippingAddress) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const session = new Session({
      id: 'offline_session',
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
      state: 'STATE_FROM_OAUTH_FLOW',
      isOnline: false,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    });

    const client = new shopify.clients.Rest({ session });

    const draftOrderPayload = {
      draft_order: {
        line_items: line_items.map(item => ({
          variant_id: item.variant_id,
          quantity: item.quantity,
          // Las propiedades personalizadas son clave para el seguimiento
          properties: item.properties ? Object.entries(item.properties).map(([name, value]) => ({ name, value })) : [],
        })),
        customer: {
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email,
          phone: customer.phone,
        },
        shipping_address: shippingAddress,
        use_customer_default_address: false,
        tags: 'EGPC, One-Step-Checkout',
        // Usamos el precio total de la oferta para crear una transacción manual
        total_price: total_price,
      },
    };
    
    const createDraftOrderResponse = await client.post({ path: 'draft_orders', data: draftOrderPayload });
    const draftOrder = createDraftOrderResponse.body.draft_order;

    // Marcar el pedido como completado
    const completedDraftOrderResponse = await client.put({ path: `draft_orders/${draftOrder.id}/complete`, data: { payment_pending: true } });
    const finalOrder = completedDraftOrderResponse.body.draft_order;

    res.status(200).json({ 
      success: true, 
      order: finalOrder
    });

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.body, null, 2) : error.message;
    console.error('Error creating order:', errorMessage);
    res.status(500).json({ success: false, message: 'Failed to create order.', error: errorMessage });
  }
};

module.exports = allowCors(handler);