```Vibe Coding/blockwage/frontend/tailwind.config.js#L1-160
/** Tailwind CSS configuration for BlockWage frontend (Next.js + TypeScript)
 *
 * - content: include Next.js pages, app, components and src folders
 * - darkMode: 'class' to support light-first with a dark-toggle
 * - theme: extend colors, fonts and container defaults for a clean modern look
 * - plugins: forms and typography for nicer default form/markdown styles
 *
 * Note: install dependencies in the frontend folder:
 *   npm install -D tailwindcss postcss autoprefixer
 *   npm install @tailwindcss/forms @tailwindcss/typography
 *
 * Also create a globals.css that includes:
 *   @tailwind base;
 *   @tailwind components;
 *   @tailwind utilities;
 *
 * and import that css in _app.tsx or the new app layout.
 */
module.exports = {
  content: [
    // Next.js default folders
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    // src is common in many setups
    "./src/**/*.{js,ts,jsx,tsx}",
    // include TS/JS in the root for scripts that might render UI
    "./frontend/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class", // enable manual dark mode toggling via a 'class' on <html>
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: "1rem",
        sm: "1rem",
        lg: "2rem",
        xl: "4rem",
        "2xl": "6rem",
      },
    },
    extend: {
      colors: {
        // Primary teal palette for a modern, professional look
        primary: {
          50: "#f0f9f9",
          100: "#e6f5f5",
          200: "#bfe9e8",
          300: "#99dfdb",
          400: "#4fd0ca",
          500: "#06b6d4", // main
          600: "#0496a8",
          700: "#03757f",
          800: "#02565b",
          900: "#01383a",
        },
        accent: {
          DEFAULT: "#f59e0b",
        },
        ui: {
          muted: "#6b7280",
          bg: "#f8fafc",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        subtle: "0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)",
        focus: "0 0 0 4px rgba(6,182,212,0.12)",
      },
      borderRadius: {
        xl: "12px",
      },
      transitionProperty: {
        height: "height",
        spacing: "margin, padding",
      },
    },
  },
  variants: {
    extend: {
      opacity: ["disabled"],
      backgroundColor: ["active"],
      translate: ["group-hover"],
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/typography"),
  ],
};
