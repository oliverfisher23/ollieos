import path from 'path';
import { gzipSync } from 'zlib';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin, type Rollup } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Most JavaScript (gzipped KB) a first page load may download: the entry chunk and
 * everything it imports statically. Lazy routes do not count. See docs/mobile-plan.md:
 * 280 holds today's single bundle; Part B lowers it to 120 once routes are split.
 */
const INITIAL_JS_BUDGET_KB = 280;

function bundleBudget(limitKb: number): Plugin {
  return {
    name: 'ollieos-bundle-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = new Map<string, Rollup.OutputChunk>();
      for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.set(item.fileName, item);
      const initial = new Set<string>();
      const visit = (chunk: Rollup.OutputChunk) => {
        if (initial.has(chunk.fileName)) return;
        initial.add(chunk.fileName);
        for (const name of chunk.imports) {
          const next = chunks.get(name);
          if (next) visit(next);
        }
      };
      for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk);
      const kb = [...initial].reduce((sum, name) => sum + gzipSync(chunks.get(name)!.code).length, 0) / 1024;
      const line = `initial JavaScript ${kb.toFixed(1)} KB gzipped (${initial.size} chunk${initial.size === 1 ? '' : 's'}), budget ${limitKb} KB`;
      if (kb > limitKb) this.error(`Bundle budget exceeded: ${line}. Lazy-load the new code or raise INITIAL_JS_BUDGET_KB in vite.config.ts on purpose.`);
      this.info(line);
    },
  };
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    bundleBudget(INITIAL_JS_BUDGET_KB),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
