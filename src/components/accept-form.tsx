"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { claimFormSubmit } from "./submit-once";

const Claimed = createContext(false);

export function AcceptForm({
  action,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  const guard = useRef(false);
  const [claimed, setClaimed] = useState(false);
  return (
    <form
      className="card pad"
      action={action}
      onSubmit={(event) => {
        if (!claimFormSubmit(guard)) {
          event.preventDefault();
          return;
        }
        setClaimed(true);
      }}
    >
      <Claimed.Provider value={claimed}>{children}</Claimed.Provider>
    </form>
  );
}

export function AcceptSubmit({ idle, pending, testId }: { idle: string; pending: string; testId: string }) {
  const claimed = useContext(Claimed);
  const { pending: busy } = useFormStatus();
  const show = claimed || busy;
  return (
    <button className="btn pri block" type="submit" disabled={show} data-testid={testId} aria-busy={show ? true : undefined}>
      {show ? pending : idle}
    </button>
  );
}
