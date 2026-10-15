import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  entry: [fileURLToPath(new URL('./lib/types/index.js', import.meta.url))],
  outDir: fileURLToPath(new URL('./lib', import.meta.url)),
  format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
