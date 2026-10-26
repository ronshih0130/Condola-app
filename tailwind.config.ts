import type { Config } from "tailwindcss";

/**
 * Window Glow names from src/app/tokens.css.
 * LINE green is only the `line` color, for LINE login / Add on LINE.
 */
const config: Config = {
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "var(--cd-primary)",
          hover: "var(--cd-primary-hover)",
          pressed: "var(--cd-primary-pressed)",
          soft: "var(--cd-primary-soft)",
        },
        accent: {
          DEFAULT: "var(--cd-accent)",
          soft: "var(--cd-accent-soft)",
        },
        ink: {
          DEFAULT: "var(--cd-ink)",
          2: "var(--cd-ink2)",
          3: "var(--cd-ink3)",
        },
        cream: "var(--cd-cream)",
        surface: {
          DEFAULT: "var(--cd-surface)",
          2: "var(--cd-surface2)",
        },
        border: {
          DEFAULT: "var(--cd-border)",
          strong: "var(--cd-border-strong)",
        },
        success: {
          DEFAULT: "var(--cd-success)",
          bg: "var(--cd-success-bg)",
        },
        warning: {
          DEFAULT: "var(--cd-warning)",
          bg: "var(--cd-warning-bg)",
        },
        danger: {
          DEFAULT: "var(--cd-danger)",
          bg: "var(--cd-danger-bg)",
        },
        info: {
          DEFAULT: "var(--cd-info)",
          bg: "var(--cd-info-bg)",
        },
        line: "#06C755",
        topbar: {
          DEFAULT: "var(--cd-topbar)",
          2: "var(--cd-topbar-2)",
          3: "var(--cd-topbar-3)",
          4: "var(--cd-topbar-4)",
        },
      },
      borderRadius: {
        sm: "var(--cd-radius-sm)",
        md: "var(--cd-radius-md)",
        lg: "var(--cd-radius-lg)",
      },
      boxShadow: {
        focus: "var(--cd-focus-ring)",
      },
      fontFamily: {
        sans: ["-apple-system", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", "sans-serif"],
      },
    },
  },
};

export default config;
