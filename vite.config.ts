import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Three.js is isolated in an on-demand FFT 3D chunk; keep the budget above
    // that intentional lazy chunk while the initial application stays smaller.
    chunkSizeWarningLimit: 600,
  },
})
