import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const PAYMONGO_BASE = 'https://api.paymongo.com/v1';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function parseJson<T>(response: Response): Promise<T> {
  const body: any = await response.json();
  return body as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function authHeader(): string {
  return `Basic ${Buffer.from(`${env.PAYMONGO_SECRET_KEY}:`).toString('base64')}`;
}

// ── Types ──

export interface CheckoutSession {
  id: string;
  type: string;
  attributes: {
    checkout_url: string;
    status: string;
    payment_intent: {
      id: string;
      attributes: {
        status: string;
        amount: number;
      };
    } | null;
    payments: Array<{
      id: string;
      type: string;
      attributes: {
        status: string;
        amount: number;
        net_amount: number;
        fee: number;
        description: string;
      };
    }>;
    reference_number?: string;
    metadata: Record<string, string> | null;
  };
}

export interface PayMongoWebhookEvent {
  data: {
    id: string;
    type: string;
    attributes: {
      type: string;
      data: CheckoutSession;
      previous_data: Record<string, unknown>;
      livemode: boolean;
      created_at: number;
      updated_at: number;
    };
  };
}

// ── Create Checkout Session ──

export async function createCheckoutSession(opts: {
  amount: number; // in PHP (e.g. 1500.00)
  description: string;
  appointmentId: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<CheckoutSession> {
  const amountCentavos = Math.round(opts.amount * 100);

  const body = {
    data: {
      attributes: {
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        description: opts.description,
        line_items: [
          {
            currency: 'PHP',
            amount: amountCentavos,
            name: 'Ocular Visit Fee',
            quantity: 1,
            description: opts.description,
          },
        ],
        payment_method_types: ['qrph'],
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        metadata: {
          appointment_id: opts.appointmentId,
          customer_id: opts.customerId,
        },
      },
    },
  };

  const response = await fetch(`${PAYMONGO_BASE}/checkout_sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    logger.error('PayMongo create checkout session failed', { status: response.status, body: errBody });
    throw new Error(`PayMongo API error (${response.status}): ${errBody}`);
  }

  const json = await parseJson<{ data: CheckoutSession }>(response);
  return json.data;
}

// ── Retrieve Checkout Session ──

export async function retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
  const response = await fetch(`${PAYMONGO_BASE}/checkout_sessions/${sessionId}`, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errBody = await response.text();
    logger.error('PayMongo retrieve checkout session failed', { status: response.status, body: errBody });
    throw new Error(`PayMongo API error (${response.status}): ${errBody}`);
  }

  const json = await parseJson<{ data: CheckoutSession }>(response);
  return json.data;
}

// ── Create Webhook (one-time setup helper) ──

export async function createWebhook(callbackUrl: string): Promise<string> {
  const body = {
    data: {
      attributes: {
        url: callbackUrl,
        events: ['checkout_session.payment.paid'],
      },
    },
  };

  const response = await fetch(`${PAYMONGO_BASE}/webhooks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    logger.error('PayMongo create webhook failed', { status: response.status, body: errBody });
    throw new Error(`PayMongo webhook creation error (${response.status}): ${errBody}`);
  }

  const json = await parseJson<{ data: { id: string } }>(response);
  return json.data.id;
}

// ── List Webhooks ──

export async function listWebhooks(): Promise<Array<{ id: string; url: string | undefined; status: string | undefined }>> {
  const response = await fetch(`${PAYMONGO_BASE}/webhooks`, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return [];
  }

  const json = await parseJson<{ data: Array<{ id: string; attributes?: { url?: string; status?: string } }> }>(response);
  return (json.data || []).map((w) => ({
    id: w.id,
    url: w.attributes?.url,
    status: w.attributes?.status,
  }));
}
