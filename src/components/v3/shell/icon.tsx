import React from "react";

// Exact paths from b042-b043-1111/mockup/app.js ic().
const paths = {
  today: "M4 9h16M4 5h16v14H4z",
  box: "M4 7l8-4 8 4-8 4-8-4zm0 0v10l8 4 8-4V7",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4",
  coin: "M12 3a9 9 0 100 18 9 9 0 000-18zM9 11h6M9 14h6",
  tool: "M14 6a4 4 0 00-5 5l-6 6 2 2 6-6a4 4 0 005-5l-2 2-2-2z",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2m12 0h2M12 4v2m0 12v2",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  bell: "M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20h4",
  chat: "M4 5h16v11H9l-5 4z",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-4 4-6 8-6s7 2 8 6",
};
export function ShellIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
