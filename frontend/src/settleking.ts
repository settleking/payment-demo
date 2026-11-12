/**
 * Loads SettleKing.js, SettleKing's widget loader, from SettleKing's payment origin. The widget is
 * an iframe on that origin: card details are typed into it and never reach this page or the
 * studio's server. The page only gets a session's client secret from the studio's server.
 */

export interface WidgetResult {
  mode: 'payment' | 'setup' | 'agreement';
  /** Agreement mode: the agreement the customer approved on SettleKing. */
  agreementId?: string;
  /** Paid (payment) or saved (setup). Always confirm it on the server before trusting it. */
  status: 'succeeded';
  paymentMethod?: { type?: string; brand?: string; last4?: string };
}

export interface WidgetError {
  /** A stable code, e.g. CARD_DECLINED, SESSION_EXPIRED. */
  code: string;
  /** Already shown inside the widget. */
  message: string;
  /** True when the customer can still try again in the widget. */
  retryable: boolean;
}

interface WidgetEvents {
  ready: { mode: 'payment' | 'setup' | 'agreement'; agreementId?: string };
  change: { paymentMethodType: string; savePaymentMethod: boolean };
  processing: undefined;
  success: WidgetResult;
  error: WidgetError;
}

export interface SettleKingWidget {
  on<E extends keyof WidgetEvents>(event: E, handler: (data: WidgetEvents[E]) => void): () => void;
  mount(target: string | HTMLElement): SettleKingWidget;
  unmount(): void;
  destroy(): void;
}

export interface WidgetAppearance {
  theme?: 'light' | 'dark' | 'auto';
  colorPrimary?: string;
  colorBackground?: string;
  colorText?: string;
  borderRadius?: number;
  fontFamily?: 'system' | 'inter' | 'roboto' | 'georgia' | 'mono';
  buttonLabel?: string;
  showMerchantHeader?: boolean;
}

export type SettleKingFactory = (publishableKey: string) => {
  widget(options: { clientSecret: string; appearance?: WidgetAppearance }): SettleKingWidget;
};

declare global {
  interface Window {
    SettleKing?: SettleKingFactory;
  }
}

let loading: Promise<SettleKingFactory> | null = null;

/**
 * Adds <script src="<payUrl>/widget/v1/settleking.js"> once. It must be a script tag served by
 * SettleKing (never bundled or self-hosted): the loader trusts only messages from its own origin.
 */
export function loadSettleKing(payUrl: string): Promise<SettleKingFactory> {
  if (window.SettleKing) return Promise.resolve(window.SettleKing);
  loading ??= new Promise<SettleKingFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${payUrl.replace(/\/+$/, '')}/widget/v1/settleking.js`;
    script.async = true;
    script.onload = () =>
      window.SettleKing ? resolve(window.SettleKing) : reject(new Error('SettleKing.js did not load.'));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('The payment form could not be loaded. Please try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}
