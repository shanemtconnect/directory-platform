import { Fragment } from "react";
import { JsonLd } from "./JsonLd";
import { breadcrumbSchema } from "@/lib/schema/builders";

export interface Crumb {
  readonly name: string;
  readonly path: string;
}

/**
 * The visible trail AND its BreadcrumbList, from one list of crumbs.
 *
 * They are emitted together deliberately. Four pages were publishing a
 * BreadcrumbList with no breadcrumb anywhere on them, which is markup asserting
 * something the page does not show — the same rule that governs ratings and
 * descriptions. Anything that takes this component gets both or neither.
 *
 * Markup matches the pillar page's trail: links, a `›` separator, and the
 * current page as plain text rather than a link to itself.
 */
export function Breadcrumbs({ trail }: { trail: readonly Crumb[] }) {
  if (trail.length === 0) return null;
  const lastIndex = trail.length - 1;

  return (
    <>
      <JsonLd data={breadcrumbSchema([...trail])} />
      <nav aria-label="Breadcrumb">
        {trail.map((crumb, i) => (
          <Fragment key={crumb.path}>
            {i > 0 && " › "}
            {i === lastIndex ? <span>{crumb.name}</span> : <a href={crumb.path}>{crumb.name}</a>}
          </Fragment>
        ))}
      </nav>
    </>
  );
}
