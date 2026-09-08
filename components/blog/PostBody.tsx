/**
 * Renders the HTML produced by `renderMarkdown`.
 *
 * `dangerouslySetInnerHTML` is safe here for one specific reason: the renderer
 * escapes the entire source before applying any markdown, so every tag in this
 * string was emitted by the renderer itself and every href passed its allow
 * list. Never pass anything to this component that has not been through it.
 */
export function PostBody({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
