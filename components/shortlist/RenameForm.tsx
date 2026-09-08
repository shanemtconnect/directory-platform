"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameShortlist } from "@/lib/actions/shortlist";

const MAX_NAME = 80;

/** Naming the list is what makes a shared link mean anything to the person who opens it. */
export function RenameForm({ name }: { name: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      data-testid="shortlist-rename"
      onSubmit={(ev) => {
        ev.preventDefault();
        setError(null);
        setSaved(false);
        start(async () => {
          const result = await renameShortlist(value);
          if (!result.ok) setError(result.message ?? "Please try again.");
          else {
            setSaved(true);
            router.refresh();
          }
        });
      }}
    >
      <label htmlFor="shortlist-name">List name</label>{" "}
      <input
        id="shortlist-name"
        name="name"
        type="text"
        maxLength={MAX_NAME}
        value={value}
        placeholder="Untitled list"
        onChange={(ev) => { setValue(ev.target.value); setSaved(false); }}
      />{" "}
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save name"}</button>
      {saved && <span role="status"> Saved</span>}
      {error && <span role="alert"> {error}</span>}
    </form>
  );
}
