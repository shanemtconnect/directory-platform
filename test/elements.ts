import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Every element in a React tree, depth first, without rendering it.
 *
 * The unit suite runs in node with no DOM and no `@types/react-dom`, so a
 * component test walks the element tree a component RETURNS rather than the
 * HTML it would produce. That is enough to assert what a page mounts and what
 * a link points at, which is what the component tests here are for.
 */
export function* elements(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* elements(childrenOf(node));
}

/**
 * What an element contains: its `children` prop for a host element or a
 * fragment, and what a synchronous function component returns for its props.
 *
 * Two kinds of component are left unexpanded, as leaves: an async one (a
 * page), which the test calls itself with its own params, and a client
 * component that uses hooks, which throws outside a renderer. The leaf is
 * still yielded, so a test can assert it was mounted and with what props.
 */
function childrenOf(el: ReactElement): ReactNode {
  if (typeof el.type === "function") {
    try {
      const rendered = (el.type as (props: unknown) => unknown)(el.props);
      return rendered instanceof Promise ? null : (rendered as ReactNode);
    } catch {
      return null;
    }
  }
  return (el.props as { children?: ReactNode }).children;
}

/** The plain text inside an element, children concatenated. */
export function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text(childrenOf(node));
  return "";
}

/** Every `<a>` in the tree as `{ href, text }`. */
export function links(node: ReactNode): { href: string; text: string }[] {
  return [...elements(node)]
    .filter((el) => el.type === "a")
    .map((el) => {
      const props = el.props as { href?: string; children?: ReactNode };
      return { href: props.href ?? "", text: text(props.children) };
    });
}
