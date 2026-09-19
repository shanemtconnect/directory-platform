import type { ReactNode } from "react";

/**
 * "Nothing here yet — and here is what happens next."
 *
 * An empty queue and a broken queue look the same when the page is blank, so
 * every list on the site says, in words, that it is empty on purpose and what
 * fills it. The optional action is the one thing a person can do about it.
 *
 * The `data-testid` lands on the wrapper, so an existing test that looked for
 * `[data-testid="x-empty"]` and read its text keeps working after the swap
 * from a bare paragraph.
 */
export interface EmptyStateProps {
  /** Short, plain. "Nothing is waiting." */
  title: ReactNode;
  /** What happens next, or what would put something here. */
  children?: ReactNode;
  action?: { href: string; label: string; testId?: string };
  testId?: string;
  className?: string;
}

export function EmptyState({ title, children, action, testId, className = "" }: EmptyStateProps) {
  return (
    <div data-testid={testId} className={`empty-state ${className}`.trim()}>
      <svg
        className="empty-state-icon"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M3 8.5 12 4l9 4.5-9 4.5z" />
        <path d="M3 8.5V16l9 4.5 9-4.5V8.5" />
        <path d="M12 13v7.5" />
      </svg>
      <p className="empty-state-title">{title}</p>
      {children !== undefined && <div className="empty-state-body">{children}</div>}
      {action !== undefined && (
        <p className="empty-state-action">
          <a href={action.href} className="btn btn-secondary" data-testid={action.testId}>
            {action.label}
          </a>
        </p>
      )}
    </div>
  );
}
