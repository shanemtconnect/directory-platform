"use client";

import { useEffect, useRef, useState } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const ONLOAD_CALLBACK = "onloadTurnstileCallback";

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      theme?: "auto" | "light" | "dark";
      "response-field"?: boolean;
      callback?: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ): string | undefined;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onloadTurnstileCallback?: () => void;
  }
}

/**
 * Widgets waiting for the script. Explicit rendering means nothing happens
 * until we ask, so a widget mounted before the script arrives has to queue.
 */
const waiting: (() => void)[] = [];

/**
 * Runs `fn` once the Turnstile script is available, and returns a function
 * that takes it back out of the queue.
 *
 * The old implicit-rendering version relied on the script scanning the page
 * for .cf-turnstile when it loaded. On a client-side navigation the script is
 * already loaded, that scan has already happened, and the widget never
 * appeared — which meant no token, and a server action that rejects every
 * submission the moment a secret is configured.
 */
function whenTurnstileReady(fn: () => void): () => void {
  if (window.turnstile) {
    fn();
    return () => {};
  }

  waiting.push(fn);
  window.onloadTurnstileCallback ??= () => {
    for (const pending of waiting.splice(0)) pending();
  };

  if (!document.querySelector(`script[src^="${SCRIPT_SRC}"]`)) {
    const script = document.createElement("script");
    script.src = `${SCRIPT_SRC}?render=explicit&onload=${ONLOAD_CALLBACK}`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  return () => {
    const at = waiting.indexOf(fn);
    if (at >= 0) waiting.splice(at, 1);
  };
}

export interface TurnstileWidgetProps {
  /** Null outside production, where the server-side check skips to match. */
  siteKey: string | null;
  /**
   * Any value that changes when the form action comes back. A Turnstile token
   * is single use, so after a rejected submission the one in the hidden field
   * is spent: without a reset every retry fails.
   */
  resetOn?: unknown;
}

export function TurnstileWidget({ siteKey, resetOn }: TurnstileWidgetProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    const el = host.current;
    if (siteKey === null || el === null) return;
    let live = true;

    const dequeue = whenTurnstileReady(() => {
      if (!live || widgetId.current !== null) return;
      widgetId.current =
        window.turnstile?.render(el, {
          sitekey: siteKey,
          theme: "auto",
          // We render the hidden input ourselves, so the form holds exactly
          // one field named cf-turnstile-response and FormData.get cannot
          // pick up an empty duplicate.
          "response-field": false,
          callback: (issued: string) => setToken(issued),
          "error-callback": () => setToken(""),
          "expired-callback": () => setToken(""),
        }) ?? null;
    });

    return () => {
      live = false;
      dequeue();
      if (widgetId.current !== null) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey]);

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (widgetId.current === null) return;
    setToken("");
    window.turnstile?.reset(widgetId.current);
  }, [resetOn]);

  if (siteKey === null) return null;

  return (
    <>
      <div ref={host} data-testid="turnstile-widget" />
      <input type="hidden" name="cf-turnstile-response" value={token} readOnly />
    </>
  );
}
