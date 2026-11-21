import React from "react";

const illustrations = {
  home: <><path d="M14 30 L32 15 L50 30 V50 H14 Z" fill="none" stroke="#14325C" strokeWidth="3" strokeLinejoin="round"/><rect x="27" y="36" width="10" height="14" fill="#2F6BFF" opacity=".25"/></>,
  chat: <><path d="M14 18 H50 V40 H30 L20 48 V40 H14 Z" fill="none" stroke="#14325C" strokeWidth="3" strokeLinejoin="round"/><circle cx="25" cy="29" r="2.5" fill="#2F6BFF"/><circle cx="32" cy="29" r="2.5" fill="#2F6BFF"/><circle cx="39" cy="29" r="2.5" fill="#2F6BFF"/></>,
  people: <><circle cx="26" cy="24" r="7" fill="none" stroke="#14325C" strokeWidth="3"/><path d="M13 48 C13 38 39 38 39 48" fill="none" stroke="#14325C" strokeWidth="3"/><circle cx="42" cy="26" r="5" fill="#2F6BFF" opacity=".3"/></>,
  doc: <><path d="M20 12 H38 L46 20 V52 H20 Z" fill="none" stroke="#14325C" strokeWidth="3" strokeLinejoin="round"/><path d="M26 30 H40 M26 37 H40 M26 44 H34" stroke="#2F6BFF" strokeWidth="3"/></>,
  coin: <><rect x="12" y="20" width="40" height="26" rx="4" fill="none" stroke="#14325C" strokeWidth="3"/><circle cx="32" cy="33" r="6" fill="#2F6BFF" opacity=".3"/></>,
  wrench: <><path d="M42 14 a10 10 0 0 0 -12 13 L14 43 l7 7 L37 34 a10 10 0 0 0 13 -12 l-6 6 -6 -2 -2 -6 Z" fill="none" stroke="#14325C" strokeWidth="3" strokeLinejoin="round"/></>,
  bell: <><path d="M20 42 V30 a12 12 0 0 1 24 0 V42 L48 46 H16 Z" fill="none" stroke="#14325C" strokeWidth="3" strokeLinejoin="round"/><circle cx="32" cy="50" r="3" fill="#2F6BFF"/></>,
  search: <><circle cx="28" cy="28" r="12" fill="none" stroke="#14325C" strokeWidth="3"/><path d="M37 37 L49 49" stroke="#14325C" strokeWidth="4" strokeLinecap="round"/></>,
  check: <><circle cx="32" cy="32" r="18" fill="none" stroke="#2A7254" strokeWidth="3"/><path d="M23 32 L30 39 L42 26" fill="none" stroke="#2A7254" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></>,
};
export type EmptyIllustrationName = keyof typeof illustrations;
export function EmptyIllustration({ name, compact = false }: { name: EmptyIllustrationName; compact?: boolean }) {
  const size = compact ? 56 : 96;
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <circle cx="32" cy="32" r="31" fill="#E3EAF3" />{illustrations[name]}
  </svg>;
}
