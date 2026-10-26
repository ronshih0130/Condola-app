/**
 * Enter in a text field must not submit a wizard or activate 下一步.
 * Enter on a select still commits the choice, so the first room pick enables 下一步.
 * Enter on an ordinary button (type="button"), a link, or a checkbox keeps the browser action.
 * Enter on a submit button is cancelled; the create button still works by click,
 * and onSubmit still requires that button.
 */
export function enterKeyAction(tagName: string, type?: string | null): "allow" | "prevent" {
  const tag = tagName.toLowerCase();
  if (tag === "textarea" || tag === "a" || tag === "select" || tag === "option") return "allow";
  if (tag === "button") {
    const kind = (type ?? "").trim().toLowerCase();
    return kind === "" || kind === "submit" ? "prevent" : "allow";
  }
  if (tag === "input" && (type ?? "").trim().toLowerCase() === "checkbox") return "allow";
  return "prevent";
}

/** IME composition (including keyCode 229) must insert text, not run the Enter guard. */
export function shouldIgnoreEnter(event: { key: string; isComposing?: boolean; keyCode?: number }) {
  if (event.key !== "Enter") return true;
  return event.isComposing === true || event.keyCode === 229;
}
