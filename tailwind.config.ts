import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        dimle: {
          bg: "#FAF9F6",
          card: "#FFFFFF",
          border: "#E8E2D9",
          "border-hover": "#D4CBC0",
          accent: "#DA7756",
          "accent-dark": "#C4623F",
          "accent-light": "#F0DDD5",
          surface: "#F5F0EA",
          "text-primary": "#2D2B28",
          "text-secondary": "#8B8580",
          "text-muted": "#ABA69F",
          "self-bg": "#F0EBE3",
          "other-bg": "#FFFFFF",
          "sidebar": "#2D2B28",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
