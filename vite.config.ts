import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split chunks for better caching
        manualChunks: {
          vendor: ['react', 'react-dom'],
          firebase: ['firebase/app', 'firebase/firestore', 'firebase/functions'],
          clerk: ['@clerk/clerk-react'],
          fontawesome: ['@fortawesome/fontawesome-svg-core', '@fortawesome/react-fontawesome']
        }
      }
    },
    // Enable source maps for better debugging
    sourcemap: true,
    // Optimize for modern browsers
    target: 'es2020'
  },
  // Optimize asset handling
  assetsInclude: ['**/*.avif', '**/*.webp'],
  // Enable CSS code splitting
  css: {
    devSourcemap: true
  },
  // Optimize dependencies
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@clerk/clerk-react',
      '@fortawesome/fontawesome-svg-core',
      '@fortawesome/react-fontawesome'
    ]
  }
})