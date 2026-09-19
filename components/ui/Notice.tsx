import type { ReactNode } from "react";

/**
 * The one way a page says "something happened".
 *
 * Three variants and no more: `status` for information ("check your inbox"),
 * `success` for a completed action ("saved"), `error` for a refused one. The
 * variant chooses the role — an error interrupts (`alert`), the other two wait
 * their turn (`status`) — and the `aria-live` is written out explicitly so the
 * announcement does not depend on which roles a given screen reader maps.
 *
 * The icon is an inline SVG with no text of its own, so a test that asserts on
 * the notice's text sees exactly the message and nothing else. Colour is never
 * the only signal: the icon shape and the role carry the meaning too.
 *
 * A server component. It takes no state and owns no behaviour, so the same
 * element renders inside a client form and a server page alike.
 */
export type NoticeVariant = "status" | "error" | "success";

export interface NoticeProps {
  variant?: NoticeVariant;
  /** A short bold lead-in, e.g. "Check that inbox". Optional. */
  title?: string;
  children: ReactNode;
  /** Passed straight through as `data-testid`. */
  testId?: string;
  id?: string;
  className?: string;
}

function Icon({ variant }: { variant: NoticeVariant }) {
  const common = {
    className: "notice-icon",
    width: 20,
    height: 20,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false" as const,
  };
  if (variant === "error") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8" />
        <path d="M10 6v5" />
        <path d="M10 14h.01" />
      </svg>
    );
  }
  if (variant === "success") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8" />
        <path d="m6.5 10.5 2.5 2.5 4.5-5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10" cy="10" r="8" />
      <path d="M10 9v5" />
      <path d="M10 6h.01" />
    </svg>
  );
}

export function Notice({
  variant = "status",
  title,
  children,
  testId,
  id,
  className = "",
}: NoticeProps) {
  const role = variant === "error" ? "alert" : "status";
  const live = variant === "error" ? "assertive" : "polite";
  return (
    <div
      role={role}
      aria-live={live}
      aria-atomic="true"
      id={id}
      data-testid={testId}
      data-variant={variant}
      className={`notice notice-${variant} ${className}`.trim()}
    >
      <Icon variant={variant} />
      <div className="notice-body">
        {title !== undefined && <strong className="notice-title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}
