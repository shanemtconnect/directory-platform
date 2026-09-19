import type { ReactNode } from "react";

/**
 * The one primary button on a form, with its pending state built in.
 *
 * While a submit is in flight the button is disabled so it cannot be pressed
 * twice, `aria-busy` says why, and the label changes to the present tense so
 * a person who cannot see the disabled styling still knows something is
 * happening. Both labels are the caller's: "Sending…" means something
 * different from "Saving…" and the button should not guess.
 *
 * No hooks, so it renders in a server form as readily as in a client one —
 * `pending` comes from `useActionState` or `useFormStatus` in the caller.
 */
export interface SubmitButtonProps {
  children: ReactNode;
  /** Shown while `pending`. */
  pendingLabel: string;
  pending: boolean;
  variant?: "primary" | "secondary";
  /** Full width on the auth and claim forms, where the button is the row. */
  block?: boolean;
  testId?: string;
  name?: string;
  value?: string;
  className?: string;
}

export function SubmitButton({
  children,
  pendingLabel,
  pending,
  variant = "primary",
  block = false,
  testId,
  name,
  value,
  className = "",
}: SubmitButtonProps) {
  const classes = ["btn", variant === "primary" ? "btn-primary" : "btn-secondary"];
  if (block) classes.push("w-full");
  if (className !== "") classes.push(className);
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-busy={pending || undefined}
      data-testid={testId}
      className={classes.join(" ")}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
