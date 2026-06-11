import type { Config } from "tailwindcss";

const config: Config = {
  // Dark mode is driven by `data-theme="dark"` on <html> (set by the
  // ThemeToggle), so `dark:` utilities track the same switch the design
  // tokens use. `.dark` is kept as a fallback selector.
  darkMode: ["variant", ['&:is([data-theme="dark"] *)', "&:is(.dark *)"]],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      // Tailwind utilities consume the namespaced `--ui-*` HSL tokens so
      // they never collide with the eidan hex tokens (`--accent`,
      // `--border`, `--muted`) the design-system primitives use.
      colors: {
        background: "hsl(var(--ui-background))",
        foreground: "hsl(var(--ui-foreground))",
        muted: {
          DEFAULT: "hsl(var(--ui-muted))",
          foreground: "hsl(var(--ui-muted-foreground))",
        },
        border: "hsl(var(--ui-border))",
        accent: {
          DEFAULT: "hsl(var(--ui-accent))",
          foreground: "hsl(var(--ui-accent-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--ui-primary))",
          foreground: "hsl(var(--ui-primary-foreground))",
        },
      },
      fontFamily: {
        sans: ["var(--font-lexend)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};

export default config;
