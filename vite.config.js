import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'dashboard',
  build: { outDir: 'dist' },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:3737', changeOrigin: true }
    }
  }
})
