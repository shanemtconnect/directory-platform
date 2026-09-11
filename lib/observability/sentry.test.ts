import { describe, it, expect, vi } from "vitest";
import {
  clientSentryDsn,
  serverSentryDsn,
  sentryOptions,
  initSentry,
  TRACES_SAMPLE_RATE,
} from "./sentry";

describe("which DSN each runtime uses", () => {
  it("prefers the server-only DSN on the server", () => {
    expect(serverSentryDsn({ SENTRY_DSN: "https://a@o1.ingest.sentry.io/1" })).toBe(
      "https://a@o1.ingest.sentry.io/1",
    );
  });

  it("falls back to the public DSN on the server", () => {
    // One DSN in one variable is the common deployment. Without this fallback a
    // site that set only NEXT_PUBLIC_SENTRY_DSN would report browser errors and
    // silently drop every server error, which is the half that matters more.
    expect(serverSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "https://b@o1.ingest.sentry.io/2" })).toBe(
      "https://b@o1.ingest.sentry.io/2",
    );
  });

  it("never lets the server-only DSN reach the browser", () => {
    expect(clientSentryDsn({ SENTRY_DSN: "https://a@o1.ingest.sentry.io/1" })).toBeUndefined();
  });

  it("uses the public DSN in the browser", () => {
    expect(clientSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "https://b@o/2" })).toBe("https://b@o/2");
  });

  it("treats blank and whitespace as unset", () => {
    expect(serverSentryDsn({ SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "  " })).toBeUndefined();
    expect(clientSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "" })).toBeUndefined();
  });
});

describe("sentryOptions", () => {
  it("samples a tenth of traces", () => {
    expect(sentryOptions("https://a@o/1", {}).tracesSampleRate).toBe(TRACES_SAMPLE_RATE);
    expect(TRACES_SAMPLE_RATE).toBe(0.1);
  });

  it("never sends PII by default", () => {
    // sendDefaultPii would attach IP addresses, cookies and request bodies —
    // enquiry forms on this site carry a member of the public's name, email and
    // message, and a third-party error tracker is not where those belong.
    expect(sentryOptions("https://a@o/1", {}).sendDefaultPii).toBe(false);
  });

  it("tags events with the site environment", () => {
    expect(sentryOptions("https://a@o/1", { SITE_ENV: "production" }).environment).toBe(
      "production",
    );
    // Anything that is not the literal "production" is staging, exactly as
    // lib/site-env.ts decides it for robots.
    expect(sentryOptions("https://a@o/1", {}).environment).toBe("staging");
    expect(sentryOptions("https://a@o/1", { SITE_ENV: "typo" }).environment).toBe("staging");
  });

  it("carries the DSN it was given", () => {
    expect(sentryOptions("https://a@o/1", {}).dsn).toBe("https://a@o/1");
  });
});

describe("initSentry", () => {
  it("does not call init when no DSN is configured", () => {
    const init = vi.fn();

    expect(initSentry(init, undefined, {})).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("calls init exactly once with the built options when a DSN is configured", () => {
    const init = vi.fn();

    expect(initSentry(init, "https://a@o/1", { SITE_ENV: "production" })).toBe(true);
    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith({
      dsn: "https://a@o/1",
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      environment: "production",
    });
  });

  it("swallows a failure inside init", () => {
    // An error tracker that cannot start must not be the thing that stops the
    // server booting or blanks the page it was meant to report on.
    const init = vi.fn(() => {
      throw new Error("bad dsn");
    });

    expect(initSentry(init, "https://a@o/1", {})).toBe(false);
  });
});
