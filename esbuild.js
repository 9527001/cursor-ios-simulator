/* eslint-disable */
const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// 清理上一次（含旧 tsc 增量产物）的构建输出，避免过时文件混入 VSIX。
fs.rmSync('out', { recursive: true, force: true });

/** Extension host：bundle 全部 TS + Tango 依赖为单个 CJS 文件。 */
const hostConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'out/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** Webview：Android 视图（含 WebCodecs 解码器）打成浏览器 IIFE。 */
const androidWebviewConfig = {
  entryPoints: ['src/webview/androidView.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'media/android-bundle.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(hostConfig),
      esbuild.context(androidWebviewConfig),
    ]);
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([
      esbuild.build(hostConfig),
      esbuild.build(androidWebviewConfig),
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
