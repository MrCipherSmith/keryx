/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "var(--color-ink)",
        paper: "var(--color-paper)",
        surface: "var(--color-surface)",
        line: "var(--color-line)",
        muted: "var(--color-muted)",
        accent: "var(--color-accent)",
        "accent-ink": "var(--color-accent-ink)",
        sage: "var(--color-sage)",
        danger: "var(--color-danger)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Fraunces", "Georgia", "serif"],
      },
      borderRadius: {
        control: "var(--radius-control)",
        panel: "var(--radius-panel)",
      },
    },
  },
  plugins: [],
};
