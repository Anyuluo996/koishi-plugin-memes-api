/**
 * Build script for the WebUI client.
 * Uses Vite directly since koishi-scripts build requires standalone packages with workspaces field.
 * Runtime dependencies (@koishijs/client, vue, vue-router) are provided by the Koishi server.
 */
const { build } = require('vite');
const path = require('path');
const fs = require('fs');

async function buildClient() {
  const cwd = process.cwd();
  const distDir = path.join(cwd, 'dist');

  await build({
    root: cwd,
    build: {
      outDir: 'dist',
      assetsDir: '',
      emptyOutDir: true,
      lib: {
        entry: path.join(cwd, 'client/index.ts'),
        fileName: 'index',
        formats: ['es'],
      },
      rollupOptions: {
        // Mark runtime dependencies as external - they are provided by Koishi server
        external: [
          'vue',
          'vue-router',
          '@koishijs/client',
          '@element-plus/icons-vue',
        ],
        output: {
          format: 'iife',
          // Generate globals for external deps
          globals: {
            'vue': 'Vue',
            'vue-router': 'VueRouter',
            '@koishijs/client': 'KoishiClient',
          },
        },
      },
    },
    plugins: [(require('@vitejs/plugin-vue'))()],
    resolve: {
      alias: {
        '@koishijs/client': path.join(cwd, 'node_modules/@koishijs/client/client/index.ts'),
      },
    },
  });

  // Rename the output from index.mjs (or index.es.js for older vite) to index.js
  const esOutput = path.join(distDir, 'index.mjs')
  const esOutputLegacy = path.join(distDir, 'index.es.js')
  const finalOutput = path.join(distDir, 'index.js')
  if (fs.existsSync(esOutput)) {
    fs.renameSync(esOutput, finalOutput)
    console.log('WebUI built successfully: dist/index.js')
  } else if (fs.existsSync(esOutputLegacy)) {
    fs.renameSync(esOutputLegacy, finalOutput)
    console.log('WebUI built successfully: dist/index.js')
  } else {
    console.error('Build failed: index.mjs not found')
    process.exit(1)
  }
}

buildClient().catch(e => {
  console.error('Build failed:', e);
  process.exit(1);
});
