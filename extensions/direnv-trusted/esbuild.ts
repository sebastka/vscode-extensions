import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Reports builds in the format expected by the `direnv-trusted: watch` problem matcher in
 * `.vscode/tasks.json`: one `file:line:column: severity: message` line per diagnostic, between
 * `[watch] build started` and `[watch] build finished` markers.
 */
const problemMatcherPlugin: esbuild.Plugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      const report = (severity: string, messages: esbuild.Message[]) => {
        for (const { text, location } of messages) {
          const where = location ? `${location.file}:${String(location.line)}:${String(location.column + 1)}` : '';
          console.error(`${where}: ${severity}: ${text}`);
        }
      };
      report('error', result.errors);
      report('warning', result.warnings);
      console.log('[watch] build finished');
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: watch ? 'silent' : 'info',
  plugins: watch ? [problemMatcherPlugin] : [],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
