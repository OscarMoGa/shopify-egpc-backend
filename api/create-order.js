  // api/create-order.js
        const Shopify = require('@shopify/shopify-api').default;
        const { LATEST_API_VERSION } = require('@shopify/shopify-api');
    
        // Initialize Shopify API (credentials will come from Vercel Environment Variables)
        const shopify = new Shopify.Clients.Rest({
          domain: process.env.SHOPIFY_SHOP_DOMAIN,
          accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
          apiVersion: LATEST_API_VERSION,
        });
    
        module.exports = async (req, res) => {
          if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
          }
    
          try {
            const { variantId, customer, shippingAddress } = req.body;
    
            if (!variantId || !customer || !shippingAddress) {
              return res.status(400).json({ success: false, message: 'Missing required fields.' });  
            }
    
            // Fetch product variant details to get price and title
            const productVariant = await shopify.get({
              path: `variants/${variantId}`,
            });
    
            if (!productVariant || !productVariant.body || !productVariant.body.variant) {
              return res.status(404).json({ success: false, message: 'Product variant not found.' });
            }
    
            const variant = productVariant.body.variant;
    
            // Create a Draft Order
            const draftOrder = new Shopify.Rest.AdminApi.DraftOrder({ session: shopify.session });
            draftOrder.line_items = [
              {
                variant_id: variant.id,
                quantity: 1, // Assuming 1 for now, can be made dynamic later
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
            draftOrder.tags = 'EGPC'; // Tag the order for easy identification
            draftOrder.note = 'Pedido generado por formulario EGPC (Pago Contra Entrega)';
            draftOrder.send_receipt = false; // Do not send receipt automatically
    
            await draftOrder.save({
              update: true,
            });
    
            // Mark as paid and complete the order (for COD)
            const completedOrder = await shopify.post({
              path: `draft_orders/${draftOrder.id}/complete`,
              data: {
                payment_pending: true, // Mark as pending payment for COD
              },
              type: 'application/json',
            });
    
            res.status(200).json({ success: true, orderId: completedOrder.body.order.id, orderNumber: completedOrder.body.order.order_number });
    
          } catch (error) {
            console.error('Error creating order:', error.response ? error.response.body : error);
            res.status(500).json({ success: false, message: 'Failed to create order.', error: error.message });
          }
        };
