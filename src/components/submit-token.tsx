"use client";

import { useEffect, useRef, useState } from "react";

/** A new token for this form mount. Empty during SSR so the markup matches, then a random id in the browser. */
export function useMountSubmitToken() {
  const ref = useRef("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!ref.current) ref.current = globalThis.crypto.randomUUID();
    setToken(ref.current);
  }, []);
  return token;
}
