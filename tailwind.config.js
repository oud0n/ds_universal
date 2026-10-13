/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        motorsport: {
          bg: '#12141a',
          card: '#1a1d26',
          panel: '#222734',
          border: '#2e3547',
          accent: '#e63946',
          car1: '#ef4444', // Red (基準車)
          car2: '#3b82f6', // Blue (比較車1)
          car3: '#10b981', // Green (比較車2)
          car4: '#f59e0b', // Orange (比較車3)
        }
      },
      fontFamily: {
        mono: ['SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'monospace'],
      }
    },
  },
  plugins: [],
}
