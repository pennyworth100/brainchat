import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        dimle: {
          bg: "#0a0a0f",
          card: "#14141f",
          border: "#1e1e2e",
          "border-hover": "#2a2a3a",
          purple: "#7c5cff",
          "purple-dark": "#5a3de8",
          cyan: "#00c6ff",
          lavender: "#a78bfa",
        },
      },
    },
  },
  plugins: [],
};

export default config;
