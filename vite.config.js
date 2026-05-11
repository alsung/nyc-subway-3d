import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  publicDir: 'public',

  build: {
    outDir: 'dist',
  },

  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.js'],
    },
  },
})