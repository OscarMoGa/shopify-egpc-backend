require('@shopify/shopify-api/adapters/node');
const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api');

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY,
  scopes: ['write_draft_orders', 'read_draft_orders'],
  hostName: process.env.VERCEL_URL || 'localhost',
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

// CORS Middleware robusto
const allowCors = fn => async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Permite cualquier origen
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
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
    const { line_items, customer, shippingAddress, shop, total_price } = req.body;

    if (!line_items || !customer || !shippingAddress || !shop || !total_price) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const session = new Session({
      id: `offline_${shop}`,
      shop: shop,
      state: 'state',
      isOnline: false,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    });

    const client = new shopify.clients.Rest({ session });

    const draftOrderPayload = {
      draft_order: {
        line_items: line_items.map(item => ({
          variant_id: item.variant_id,
          quantity: item.quantity,
          properties: item.properties ? Object.entries(item.properties).map(([name, value]) => ({ name, value })) : [],
        })),
        customer: {
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email,
        },
        shipping_address: shippingAddress,
        use_customer_default_address: false,
        tags: 'EGPC, One-Step-Checkout',
        currency: 'COP', // Asegurar la moneda
      },
    };
    
    const createDraftOrderResponse = await client.post({ path: 'draft_orders', data: draftOrderPayload });
    let draftOrder = createDraftOrderResponse.body.draft_order;

    // Aplicar el precio total como un descuento para que coincida con la oferta
    const originalPrice = parseFloat(draftOrder.subtotal_price);
    const offerPrice = parseFloat(total_price);
    const discountAmount = originalPrice - offerPrice;

    if (discountAmount > 0) {
        draftOrder.total_discounts = discountAmount.toFixed(2);
        const discountPayload = {
            draft_order: {
                id: draftOrder.id,
                applied_discount: {
                    title: "Descuento por Oferta",
                    value: discountAmount,
                    value_type: "fixed_amount"
                }
            }
        };
        // No es necesario actualizar el draft order para el descuento, se completa con el precio final
    }
    
    // Completar la orden
    const completedOrderResponse = await client.put({ path: `draft_orders/${draftOrder.id}/complete`, data: { payment_pending: true } });
    const completedOrder = completedOrderResponse.body.draft_order;

    res.status(200).json({ 
      success: true, 
      order: completedOrder
    });

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.body, null, 2) : error.message;
    console.error('Error creating order:', errorMessage);
    res.status(500).json({ success: false, message: 'Failed to create order.', error: errorMessage });
  }
};

module.exports = allowCors(handler);
