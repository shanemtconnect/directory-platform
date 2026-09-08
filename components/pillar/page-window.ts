/** A rendered page number, or the ellipsis standing for the ones left out. */
export type PageSlot = number | "gap";

const RADIUS = 2;

/**
 * Which page numbers a pagination control should render.
 *
 * The old control rendered 1..N. On /search that is 200 listings over nine
 * pages, which is survivable; on a city that has grown to four hundred it is a
 * row of four hundred links in the DOM of every paginated URL, and a crawler
 * following all of them from all of them.
 *
 * First and last are always present so the ends stay one click away, and a gap
 * that hides exactly one page renders that page instead — an ellipsis standing
 * for a single number costs the same width and gives back nothing.
 */
export function pageWindow(page: number, totalPages: number, radius = RADIUS): PageSlot[] {
  if (totalPages < 1) return [];

  const shown = new Set<number>([1, totalPages]);
  for (let n = page - radius; n <= page + radius; n++) {
    if (n >= 1 && n <= totalPages) shown.add(n);
  }

  const slots: PageSlot[] = [];
  let previous = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (previous !== 0) {
      if (n - previous === 2) slots.push(previous + 1);
      else if (n - previous > 2) slots.push("gap");
    }
    slots.push(n);
    previous = n;
  }
  return slots;
}
