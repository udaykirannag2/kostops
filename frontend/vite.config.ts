import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir:        'dist',
    sourcemap:     false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:  ['react', 'react-dom', 'react-router-dom'],
          amplify: ['aws-amplify', '@aws-amplify/ui-react'],
        },
      },
    },
  },
  server: {
    port: 3000,
  },
});
