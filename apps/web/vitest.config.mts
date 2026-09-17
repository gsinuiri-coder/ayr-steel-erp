import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Unit tests de funciones puras del web (D-011): el resto de la UI se verifica con Playwright
 *  (`e2e/`), no acá — esto es solo para lógica sin DOM como `src/lib/audit-labels.ts`. */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
