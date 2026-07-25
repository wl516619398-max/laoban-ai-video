import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "Arial", "sans-serif"],
      },
      colors: {
        ink: "#17241f",
        mint: "#dff8e9",
        brand: "#0e7548",
        coral: "#f36f4f",
      },
      boxShadow: {
        soft: "0 20px 50px rgba(35, 67, 49, 0.11)",
      },
    },
  },
  plugins: [],
};

export default config;

