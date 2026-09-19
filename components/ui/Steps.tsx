/**
 * Where you are in a flow that has more than one page.
 *
 * A numbered list, because that is what it is: the steps are real pages in a
 * fixed order and a screen reader should hear "step 2 of 4, Confirm by email"
 * rather than a row of unlabelled circles. `aria-current="step"` marks the
 * current one; the sr-only prefix says the position in words.
 *
 * On a phone only the current step keeps its label, so four steps fit on one
 * line at 360px — the others are still numbered, and still read out in full.
 */
export interface StepsProps {
  steps: readonly string[];
  /** Zero-based index of the step this page is. */
  current: number;
  /** Names the list for assistive technology. Defaults to "Progress". */
  label?: string;
  className?: string;
}

export function Steps({ steps, current, label = "Progress", className = "" }: StepsProps) {
  return (
    <ol className={`steps ${className}`.trim()} aria-label={label} data-testid="steps">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li
            key={step}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="steps-index" aria-hidden="true">
              {state === "done" ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                  <path d="m2.5 6.5 2.5 2.5 4.5-5" />
                </svg>
              ) : (
                index + 1
              )}
            </span>
            <span className="sr-only">
              Step {index + 1} of {steps.length}
              {state === "done" ? ", done" : state === "current" ? ", current" : ""}:{" "}
            </span>
            <span className="steps-label">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
