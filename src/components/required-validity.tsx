"use client";

import { useEffect } from "react";

function isField(value: EventTarget | null): value is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement || value instanceof HTMLSelectElement;
}

/** Browser locale owns the native required tooltip. Set the product message before it is shown. */
export function RequiredValidity({ message }: { message: string }) {
  useEffect(() => {
    const onInvalid = (event: Event) => {
      if (!isField(event.target) || !event.target.validity.valueMissing) return;
      event.target.setCustomValidity(message);
    };
    const onInput = (event: Event) => {
      if (isField(event.target)) event.target.setCustomValidity("");
    };
    document.addEventListener("invalid", onInvalid, true);
    document.addEventListener("input", onInput, true);
    return () => {
      document.removeEventListener("invalid", onInvalid, true);
      document.removeEventListener("input", onInput, true);
    };
  }, [message]);
  return null;
}
