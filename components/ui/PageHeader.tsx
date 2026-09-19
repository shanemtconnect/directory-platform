import type { ReactNode } from "react";

/**
 * Every signed-in and staff page opens the same way: an optional way back, one
 * `h1`, one line saying what the page is for, and — when there is one — a row
 * of links or a count under it.
 *
 * The back link is a real anchor, not `history.back()`: the page a person
 * arrived from is not always the page above this one, and a link that says
 * where it goes is one that can be trusted on a phone with no visible URL.
 *
 * The `h1` carries `title` and nothing else, so a test that reads the heading
 * reads exactly the name of the thing.
 */
export interface PageHeaderProps {
  title: ReactNode;
  /** One sentence under the heading. What this page is for. */
  lede?: ReactNode;
  back?: { href: string; label: string; testId?: string };
  /** Rendered under the lede: a line of links, a count, a status pill. */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, lede, back, children, className = "" }: PageHeaderProps) {
  return (
    <header className={`page-header ${className}`.trim()}>
      {back !== undefined && (
        <p className="page-header-back">
          <a href={back.href} data-testid={back.testId}>
            <span aria-hidden="true">← </span>
            {back.label}
          </a>
        </p>
      )}
      <h1>{title}</h1>
      {lede !== undefined && <p className="page-header-lede text-muted">{lede}</p>}
      {children !== undefined && <div className="page-header-meta">{children}</div>}
    </header>
  );
}
