import React from "react";
import type { Locale } from "@/i18n";

const LOCKUP = {
  horizontal: "/brand/condola_lockup_horizontal.svg",
  horizontalDark: "/brand/condola_lockup_horizontal_dark.svg",
  stacked: "/brand/condola_lockup_stacked.svg",
  stackedDark: "/brand/condola_lockup_stacked_dark.svg",
  symbol: "/brand/condola_symbol.svg",
  symbolSmall: "/brand/condola_symbol_small.svg",
} as const;

export type BrandVariant = keyof typeof LOCKUP;

export function BrandImage({
  variant,
  alt,
  className,
  v2,
  locale,
}: {
  variant: BrandVariant;
  alt: string;
  className?: string;
  v2?: boolean;
  locale?: Locale;
}) {
  if (v2 && variant === "stacked") {
    // R&D 02:09: use lockup_stacked_dark.svg on navy surfaces; no current placement is navy (see e2e brand-v2 probe)
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={[className, "stacked-v2"].filter(Boolean).join(" ")} src="/brand/v2/logo/lockup_stacked_color.svg" alt={alt} width={200} height={148} />;
  }
  if (v2 && (variant === "horizontal" || variant === "horizontalDark")) {
    const zh = locale === "zh-TW";
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={zh ? "/brand/v2/logo/lockup_zh_color.svg" : "/brand/v2/logo/lockup_en_color.svg"} alt={alt} width={Math.round((zh ? 380.03 : 479.16) * 28 / 120)} height={28} />;
  }
  if (v2 && variant === "symbolSmall") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src="/brand/v2/logo/symbol_color.svg" alt={alt} width={24} height={24} />;
  }
  // The Cloudflare adapter does not run the Next image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={LOCKUP[variant]} alt={alt} />;
}

/** Centred stacked mark for auth and onboarding. */
export function AuthBrand({ name, v2 }: { name: string; v2?: boolean }) {
  if (v2) {
    return (
      <div className="auth-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="auth-brand-v2" src="/brand/v2/logo/lockup_stacked_color.svg" alt={name} width={200} height={148} />
      </div>
    );
  }
  return (
    <div className="auth-brand">
      <BrandImage variant="stacked" alt={name} />
    </div>
  );
}
