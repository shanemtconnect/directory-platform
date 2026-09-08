import { CopyButton } from "./CopyButton";

/**
 * A block of code to copy. React escapes the children of <code>, so the raw
 * snippet is displayed rather than executed — never swap this for
 * dangerouslySetInnerHTML.
 */
export function SnippetBlock({
  code, heading, note, copyLabel,
}: {
  code: string;
  heading?: string;
  note?: string;
  copyLabel?: string;
}) {
  return (
    <div className="my-4">
      <div className="flex items-baseline justify-between gap-4">
        {heading ? <h4 className="m-0 text-sm font-semibold">{heading}</h4> : <span />}
        <CopyButton text={code} label={copyLabel} />
      </div>
      {note && <p className="mt-1 mb-2 text-sm text-neutral-600">{note}</p>}
      <pre className="overflow-x-auto rounded border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
