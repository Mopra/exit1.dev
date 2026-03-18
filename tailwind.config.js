/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%': { opacity: '0.8', transform: 'scale(1.05)' },
        },
        'glow-spin': {
          '0%': { backgroundImage: 'linear-gradient(0deg, #10b981, #06b6d4, #10b981)' },
          '25%': { backgroundImage: 'linear-gradient(90deg, #10b981, #06b6d4, #10b981)' },
          '50%': { backgroundImage: 'linear-gradient(180deg, #10b981, #06b6d4, #10b981)' },
          '75%': { backgroundImage: 'linear-gradient(270deg, #10b981, #06b6d4, #10b981)' },
          '100%': { backgroundImage: 'linear-gradient(360deg, #10b981, #06b6d4, #10b981)' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 2.5s ease-in-out infinite',
        'glow-spin': 'glow-spin 3s linear infinite',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} 