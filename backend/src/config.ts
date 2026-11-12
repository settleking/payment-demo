import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';

/** Everything the studio reads from the environment, checked once at start-up. */
@Injectable()
export class AppConfig {
  readonly port = Number(process.env.PORT ?? 4400);
  readonly studioName = process.env.STUDIO_NAME ?? 'Tempo Dance Studio';
  /** Where customers reach this site; the SettleKing return URL is built from it. Must be HTTPS. */
  readonly publicUrl = trimSlash(process.env.PUBLIC_URL ?? 'http://localhost:4400');
  readonly dataDir = resolve(process.env.DATA_DIR ?? 'data');
  readonly frontendDist = resolve(process.env.FRONTEND_DIST ?? resolve(__dirname, '../../frontend/dist'));

  readonly settleking = {
    /** SettleKing's API origin. */
    apiUrl: trimSlash(process.env.SETTLEKING_API_URL ?? 'https://api-v2.stage.settleking.com'),
    /** The hosted checkout page; the checkout id is appended. */
    checkoutUrl: trimSlash(process.env.SETTLEKING_CHECKOUT_URL ?? 'https://pay.stage.settleking.com/checkout'),
    clientId: process.env.SETTLEKING_CLIENT_ID ?? '',
    clientSecret: process.env.SETTLEKING_CLIENT_SECRET ?? '',
    /** The endpoint's whsec_ secret from SettleKing's Developer setup > Webhooks. */
    webhookSecret: process.env.SETTLEKING_WEBHOOK_SECRET ?? '',
    /**
     * Narrows hosted checkouts to some of the merchant's enabled methods: a comma list of
     * `card` and/or `wallet`. Empty offers everything the merchant has enabled.
     */
    paymentMethods: parseMethods(process.env.SETTLEKING_PAYMENT_METHODS),
    /** The name payers see on the checkout page. */
    merchantName: process.env.SETTLEKING_MERCHANT_NAME ?? process.env.STUDIO_NAME ?? 'Tempo Dance Studio',
    /** The widget created in SettleKing's Developer setup > Widgets (its uuid). */
    widgetId: process.env.SETTLEKING_WIDGET_ID ?? '',
    /** The widget's pk_test_/pk_live_ key. Public: it goes in the page, it cannot charge anything. */
    publishableKey: process.env.SETTLEKING_PUBLISHABLE_KEY ?? '',
    /** SettleKing's payment origin; the page loads <payUrl>/widget/v1/settleking.js from it. */
    payUrl: trimSlash(process.env.SETTLEKING_PAY_URL ?? 'https://pay.stage.settleking.com'),
    /** SettleKing's web app, where customers manage their plans and limits (linked from the page). */
    appUrl: trimSlash(process.env.SETTLEKING_APP_URL ?? 'https://app.stage.settleking.com'),
  };

  /** The monthly membership the studio admin charges to members' saved cards, in US cents. */
  readonly membershipAmount = 4900;

  /** Sent by the studio admin panel as X-Admin-Token. Unset disables the admin API. */
  readonly adminToken = process.env.ADMIN_TOKEN ?? '';

  get paymentsConfigured(): boolean {
    return Boolean(this.settleking.clientId && this.settleking.clientSecret);
  }

  /** Whether the page may offer the embedded widget ("Pay here", memberships). */
  get widgetsConfigured(): boolean {
    return this.paymentsConfigured && Boolean(this.settleking.widgetId && this.settleking.publishableKey);
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseMethods(value: string | undefined): ('CARD' | 'WALLET')[] {
  const methods = (value ?? '')
    .split(',')
    .map((method) => method.trim().toUpperCase())
    .filter(Boolean);
  const unknown = methods.filter((method) => method !== 'CARD' && method !== 'WALLET');
  if (unknown.length) throw new Error(`SETTLEKING_PAYMENT_METHODS: unknown method ${unknown.join(', ')} (use card, wallet)`);
  return [...new Set(methods)] as ('CARD' | 'WALLET')[];
}
