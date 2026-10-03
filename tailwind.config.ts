import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        dimle: {
          bg: "#F8F9FB",
          card: "#FFFFFF",
          border: "#CBD1DA",
          "border-hover": "#8793A5",
          accent: "#002664",
          "accent-dark": "#001A45",
          "accent-light": "#E6EDF7",
          surface: "#F0F3F7",
          "text-primary": "#000C1F",
          "text-secondary": "#44536A",
          "text-muted": "#536177",
          "self-bg": "#E6EDF7",
          "other-bg": "#FFFFFF",
          "sidebar": "#000C1F",
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
