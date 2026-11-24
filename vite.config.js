import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: '.',
  publicDir: 'public',

  build: {
    outDir: 'dist',
    rollupOptions: {
      // The 404 page's script (#119) is built on its own, as
      // assets/not-found-<hash>.js, and scripts/build-seo-pages.mjs writes the
      // page around it. A second HTML page here would share Vite's preload
      // helper and the stylesheet with the map, and the build would move both
      // into files of their own: two more downloads for every visit to the map.
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        'not-found': fileURLToPath(new URL('./src/not-found.js', import.meta.url)),
      },
    },
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
