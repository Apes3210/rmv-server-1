import { Router, Request, Response } from 'express';
import { handlePaymongoPayment } from '../appointments/appointments.service.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * PayMongo Webhook Handler
 * POST /api/v1/webhooks/paymongo
 *
 * PayMongo sends checkout_session.payment.paid events here.
 * This endpoint bypasses CSRF protection (registered before CSRF middleware).
 */
router.post('/paymongo', async (req: Request, res: Response) => {
  try {
    const event = req.body;

    if (!event?.data?.attributes?.type) {
      logger.warn('PayMongo webhook: missing event type');
      res.status(400).json({ error: 'Invalid event' });
      return;
    }

    const eventType = event.data.attributes.type;
    logger.info(`PayMongo webhook received: ${eventType}`);

    if (eventType === 'checkout_session.payment.paid') {
      const checkoutSession = event.data.attributes.data;
      const sessionId = checkoutSession?.id;

      if (!sessionId) {
        logger.warn('PayMongo webhook: no session ID in event');
        res.status(400).json({ error: 'Missing session ID' });
        return;
      }

      const appointment = await handlePaymongoPayment(sessionId);

      if (appointment) {
        logger.info(`PayMongo webhook: ocular fee verified for appointment ${appointment._id}`);
      } else {
        logger.info(`PayMongo webhook: no matching appointment for session ${sessionId}`);
      }
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('PayMongo webhook error:', error);
    // Still return 200 to prevent retries on our processing errors
    res.status(200).json({ success: true });
  }
});

export default router;
