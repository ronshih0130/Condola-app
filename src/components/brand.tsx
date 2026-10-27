import React from "react";

const LOCKUP = {
  horizontal: "/brand/condola_lockup_horizontal.svg",
  horizontalDark: "/brand/condola_lockup_horizontal_dark.svg",
  stacked: "/brand/condola_lockup_stacked.svg",
  stackedDark: "/brand/condola_lockup_stacked_dark.svg",
  symbol: "/brand/condola_symbol.svg",
  symbolSmall: "/brand/condola_symbol_small.svg",
} as const;

export type BrandVariant = keyof typeof LOCKUP;

const V2_HEADER = {
  horizontalDark: "/brand/v2/logo/lockup_en_dark.svg",
  symbolSmall: "/brand/v2/logo/symbol_dark.svg",
} as const;

export function BrandImage({
  variant,
  alt,
  className,
  v2,
}: {
  variant: BrandVariant;
  alt: string;
  className?: string;
  v2?: boolean;
}) {
  if (v2 && (variant === "horizontalDark" || variant === "symbolSmall")) {
    const symbol = variant === "symbolSmall";
    // Existing CSS retains the responsive box; dimensions supply the intrinsic ratio.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={V2_HEADER[variant]} alt={alt} width={symbol ? 24 : 24 * 479.16 / 120} height={24} />;
  }
  // The Cloudflare adapter does not run the Next image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={LOCKUP[variant]} alt={alt} />;
}

/** Centred stacked mark for auth and onboarding. The file is wider than 140px. */
export function AuthBrand({ name }: { name: string }) {
  return (
    <div className="auth-brand">
      <BrandImage variant="stacked" alt={name} />
    </div>
  );
}
