"use client";

import { useState } from "react";

/**
 * Copy-to-clipboard with a visible confirmation. The text is passed as a prop
 * rather than scraped from the DOM so what gets copied is exactly what the
 * server generated, whitespace and all.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (no permission, insecure origin). The <pre> is still
      // selectable, so the fallback is manual selection — no error state needed.
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
