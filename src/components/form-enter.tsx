"use client";

import type { KeyboardEvent } from "react";
import { enterKeyAction, shouldIgnoreEnter } from "./enter-key";

export function blockImplicitEnter(event: KeyboardEvent<HTMLFormElement>) {
  const native = event.nativeEvent;
  if (shouldIgnoreEnter({ key: event.key, isComposing: native.isComposing, keyCode: native.keyCode })) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    event.preventDefault();
    return;
  }
  if (target.closest("a")) return;
  const button = target instanceof HTMLButtonElement ? target : target.closest("button");
  if (button instanceof HTMLButtonElement) {
    if (enterKeyAction("button", button.type) === "prevent") event.preventDefault();
    return;
  }
  const fieldType = target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.type : "";
  if (enterKeyAction(target.tagName, fieldType) === "prevent") event.preventDefault();
}

/** First submit control, so Enter in a text field does not click 下一步. onSubmit ignores it. */
export function ImplicitSubmitSink() {
  return <button type="submit" hidden tabIndex={-1} aria-hidden="true" formNoValidate data-implicit-submit="true" />;
}
