"use client";

import { useEffect, useRef } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/**
 * Renders the Turnstile challenge, or nothing at all when no site key is
 * configured — local and staging run without one, and the server-side check
 * skips in exactly the same case (see lib/spam/turnstile.ts).
 */
export function TurnstileWidget({ siteKey }: { siteKey: string | null }) {
  const loaded = useRef(false);

  useEffect(() => {
    if (siteKey === null || loaded.current) return;
    if (document.querySelector(`script[src^="${SCRIPT_SRC}"]`)) {
      loaded.current = true;
      return;
    }
    const script = document.createElement("script");
    // Implicit rendering: the script finds .cf-turnstile on load and injects
    // the cf-turnstile-response input the server action reads.
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
    loaded.current = true;
  }, [siteKey]);

  if (siteKey === null) return null;
  return <div className="cf-turnstile" data-sitekey={siteKey} data-theme="auto" />;
}
