import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { headFromStatPlugin } from './tools/lib/vite-head-from-stat';

/**
 * The build id the update notifier compares against /version.json
 * (packages/renderer/src/update/UpdateWatcher.ts). ACJS_BUILD_ID (the AWS
 * deploy agent passes the commit) or a BUILD_ID file wins; a local production
 * build gets a timestamp; the dev server is 'dev' (never polls).
 */
function resolveBuildId(command: 'build' | 'serve'): string {
  if (process.env.ACJS_BUILD_ID) return process.env.ACJS_BUILD_ID.trim();
  const file = resolve(__dirname, 'BUILD_ID');
  if (existsSync(file)) {
    const id = readFileSync(file, 'utf8').trim();
    if (id) return id;
  }
  return command === 'build' ? `local-${Date.now()}` : 'dev';
}

/** Emit build-id.txt next to index.html; the web container serves it as /version.json. */
function emitBuildId(buildId: string): Plugin {
  return {
    name: 'acjs-build-id',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: `${buildId}\n` });
    },
  };
}

export default defineConfig(({ command }) => {
  const buildId = resolveBuildId(command);
  return {
  define: { 'import.meta.env.VITE_ACJS_BUILD_ID': JSON.stringify(buildId) },
  // headFromStatPlugin: a dev HEAD for a DAT answers from stat instead of
  // reading all 926 MB through sirv (OPS.vite-head-dat-stall).
  plugins: [emitBuildId(buildId), headFromStatPlugin()],
  root: resolve(__dirname, 'packages/renderer'),
  // Dev serves the DATs (and the weenie side-files) straight out of dat/.
  // A production build must NOT copy them into the bundle (1.4 GB of DATs +
  // world.sqlite): they are hosted separately and reached through the runtime
  // config's assetBase (docs/release-plan.md, docs/dat-streaming.md).
  publicDir: command === 'serve' ? resolve(__dirname, 'dat') : false,
  server: {
    port: 3000,
  },
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@ac/shared': resolve(__dirname, 'packages/shared/src'),
      // Without this alias Vite resolves @ac/network through the workspace
      // symlink and pre-bundles it as a dependency: edits under
      // packages/network/src never reach the running dev server (a stale
      // parser served the CORE.17.o.a after-capture until a --force restart).
      '@ac/network': resolve(__dirname, 'packages/network/src'),
      '@ac/dat-parser': resolve(__dirname, 'packages/dat-parser/src'),
      '@ac/renderer': resolve(__dirname, 'packages/renderer/src'),
    },
  },
};
});
