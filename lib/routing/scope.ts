/**
 * The one abstraction that keeps both site modes on a single router.
 *
 * niche-national uses the city scopes, local-multi-vertical uses the vertical
 * scopes, and every query builder, sort expression, schema builder and
 * component tree downstream takes a PillarScope rather than knowing which mode
 * it is running in.
 */
export type PillarScope =
  | { type: "city"; cityId: string }
  | { type: "city-category"; cityId: string; categoryId: string }
  | { type: "vertical"; verticalId: string }
  | { type: "vertical-area"; verticalId: string; areaId: string };

/** The id a scope's listings are filtered by, whichever axis the site uses. */
export function scopeParentId(scope: PillarScope): string {
  switch (scope.type) {
    case "city":
    case "city-category":
      return scope.cityId;
    case "vertical":
    case "vertical-area":
      return scope.verticalId;
  }
}
