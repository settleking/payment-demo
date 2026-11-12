import { useEffect, useRef, useState } from 'react';

import { SiteConfig } from './api';
import { loadSettleKing, SettleKingWidget, WidgetResult } from './settleking';

interface Props {
  widget: NonNullable<SiteConfig['widget']>;
  /** From the studio's server, for this one session. */
  clientSecret: string;
  /** The widget says it is done. Only a hint: the page then asks the server to confirm. */
  onSuccess: (result: WidgetResult) => void;
  /** The form cannot continue (failed to load, session expired, …). */
  onFatal: (message: string) => void;
}

/** Mounts a SettleKing widget (payment, save-card or agreement approval) for one widget session. */
export function PaymentWidget({ widget, clientSecret, onSuccess, onFatal }: Props) {
  const target = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  // The latest callbacks, so the widget is mounted once per session rather than on every render.
  const handlers = useRef({ onSuccess, onFatal });
  handlers.current = { onSuccess, onFatal };

  useEffect(() => {
    let active = true;
    let mounted: SettleKingWidget | undefined;
    setReady(false);
    loadSettleKing(widget.payUrl)
      .then((SettleKing) => {
        if (!active || !target.current) return;
        mounted = SettleKing(widget.publishableKey).widget({
          clientSecret,
          // On top of the appearance set in SettleKing's dashboard: SettleKing's green and Inter.
          appearance: { colorPrimary: '#14683f', borderRadius: 14, fontFamily: 'inter' },
        });
        mounted.on('ready', () => setReady(true));
        mounted.on('success', (result) => handlers.current.onSuccess(result));
        mounted.on('error', (error) => {
          // Retryable errors (a declined card, a typo) are shown and fixed inside the widget.
          if (!error.retryable) handlers.current.onFatal(error.message);
        });
        mounted.mount(target.current);
      })
      .catch((reason: Error) => {
        if (active) handlers.current.onFatal(reason.message);
      });
    return () => {
      active = false;
      mounted?.destroy();
    };
  }, [widget.payUrl, widget.publishableKey, clientSecret]);

  return (
    <div className="widget-box" aria-busy={!ready}>
      {!ready && (
        <div className="widget-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span className="muted">Loading SettleKing’s secure form…</span>
        </div>
      )}
      <div ref={target} />
    </div>
  );
}
