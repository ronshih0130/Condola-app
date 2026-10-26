import type { Metadata } from "next";
import { MissingPage } from "@/components/missing-page";

export const metadata: Metadata = {
  title: { absolute: "找不到這個頁面｜租多啦" },
};

export default function NotFound() {
  return (
    <div className="main">
      <MissingPage href="/" />
    </div>
  );
}
