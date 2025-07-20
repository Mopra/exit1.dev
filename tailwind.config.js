module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['IBM Plex Mono', 'Fira Mono', 'Courier New', 'monospace'],
        serif: ['IBM Plex Serif', 'Georgia', 'Times New Roman', 'serif'],
      },
    },
  },
  plugins: [],
} 