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
  horizontalDark: "/brand/v2/logo/lockup_en_color.svg",
  symbolSmall: "/brand/v2/logo/symbol_color.svg",
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
  if (v2 && variant === "stacked") {
    // R&D 02:09: use lockup_stacked_dark.svg on navy surfaces; no current placement is navy (see e2e brand-v2 probe)
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={[className, "stacked-v2"].filter(Boolean).join(" ")} src="/brand/v2/logo/lockup_stacked_color.svg" alt={alt} width={200} height={148} />;
  }
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
