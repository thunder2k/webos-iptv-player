import * as esbuild from 'esbuild';
import { cpSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs';
import {
  LEGACY_JS_BANNER,
  scanBundle,
  formatViolations,
} from './scripts/compat-gate.mjs';
import { validateShakaBundle } from './scripts/shaka-compat-gate.mjs';
import {
  convertLegacyColorSyntax,
  generateFlexGapFallback,
  linkedStylesheets,
  scaleFontSizes,
  resolveCSSVariables,
} from './scripts/css-transforms.mjs';
import { transpileToES5 } from './scripts/transpile-es5.mjs';

const isPreview = process.argv.includes('--preview');
// Checked-in but regenerated on every build; never a source input.
const GENERATED_STYLESHEET = 'legacy-webos-base.css';
// Read version from package.json (single source of truth)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

// Sync version to appinfo.json
const appinfo = JSON.parse(readFileSync('appinfo.json', 'utf8'));
if (appinfo.version !== version) {
  appinfo.version = version;
  writeFileSync('appinfo.json', JSON.stringify(appinfo, null, 2) + '\n');
}

function transformStylesheets(outDir) {
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith('.css')) continue;
    const path = `${outDir}/${file}`;
    let css = convertLegacyColorSyntax(readFileSync(path, 'utf8'));
    css = scaleFontSizes(css);
    css = resolveCSSVariables(css);
    writeFileSync(path, css);
  }
}

// Copy static assets to dist. The source HTML is the production/webOS version;
// preview builds swap only the platform library at build time.
mkdirSync('dist', { recursive: true });
const indexHtml = readFileSync('index.html', 'utf8');
const previewLibsMarker = '<!-- preview-libs -->';
const buildTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
let outputIndexHtml = indexHtml
  .replace('__APP_VERSION__', version)
  .replace('__BUILD_TIME__', buildTime)
  .replace(
    previewLibsMarker,
    isPreview ? '<script src="js/preview-libs.js"></script>' : '',
  );
if (outputIndexHtml === indexHtml) {
  throw new Error('Build could not find the preview library marker in index.html.');
}

writeFileSync('dist/index.html', outputIndexHtml);
cpSync('appinfo.json', 'dist/appinfo.json');
rmSync('dist/resources', { recursive: true, force: true });
cpSync('resources', 'dist/resources', { recursive: true });
// Refresh the flex-`gap` fallback; see its header for the cascade rationale.
const sourceStylesheets = linkedStylesheets(indexHtml, readdirSync('css'), GENERATED_STYLESHEET)
  .map((file) => readFileSync(`css/${file}`, 'utf8'));
writeFileSync(`css/${GENERATED_STYLESHEET}`, generateFlexGapFallback(sourceStylesheets));
cpSync('css', 'dist/css', { recursive: true });
transformStylesheets('dist/css');
cpSync('assets/icon80.png', 'dist/icon.png');
cpSync('assets/icon130.png', 'dist/largeIcon.png');
cpSync('assets/group-icons', 'dist/assets/group-icons', { recursive: true });
cpSync('assets/icons', 'dist/assets/icons', { recursive: true });

// Main app bundle — playback libraries remain separate. Shaka is shipped as a
// lazy TV bundle for Widevine and is also used by the desktop preview.
// webOS 3.9 (Chromium 38) does not support ES modules (Chrome 61+) or ES2015+
// syntax (arrow functions, let/const, classes, etc.). esbuild targets es2015
// to down-level post-ES2015 syntax (`?.` / `??` / dynamic import / async-await)
// so Chromium 38 can parse it; runtime APIs are covered by src/polyfills.ts.
const serviceId = JSON.parse(readFileSync('bundled-service/src/services.json', 'utf8')).id;
const define = {
  '__APP_VERSION__': JSON.stringify(version),
  '__APP_ID__': JSON.stringify(appinfo.id),
  '__SERVICE_ID__': JSON.stringify(serviceId),
  '__ENABLE_PSEUDO_LOCALE__': JSON.stringify(isPreview),
};
const TARGET = ['es2015'];
const FORMAT = 'iife';

const appBuild = {
  entryPoints: ['src/app.ts'],
  bundle: true,
  format: FORMAT,
  target: TARGET,
  banner: { js: LEGACY_JS_BANNER },
  external: ['hls.js', 'mpegts.js', 'shaka-player'],
  define,
};
const workerBuild = {
  entryPoints: ['src/workers/app-worker.ts'],
  bundle: true,
  format: FORMAT,
  target: TARGET,
  banner: { js: LEGACY_JS_BANNER },
  define,
};

// Build a non-minified esbuild bundle in memory, scan it with the Chromium-38
// compat gate, then minify and write out. esbuild's es2015 target already
// down-levels post-ES2015 syntax (?. / ?? / dynamic import / async-await) so
// Chromium 38 can parse it; runtime APIs are covered by src/polyfills.ts and
// guarded by the compat gate. Then transpile ES2015 syntax to ES5 for Chromium 38.
async function buildAndMinify(config, outfile, label) {
  const scan = await esbuild.build({ ...config, minify: false, write: false });
  const violations = scanBundle(scan.outputFiles[0].text);
  if (violations.length > 0) {
    throw new Error(`${label} bundle:\n${formatViolations(violations)}`);
  }
  await esbuild.build({ ...config, minify: true, outfile, target: TARGET, write: true });
  // Transpile ES2015 syntax (classes, arrow functions, template literals, etc.) to ES5
  // for Chromium 38 (webOS 3.9) compatibility.
  transpileToES5(outfile, outfile);
}

const shippedBuilds = [
  { name: 'app', config: appBuild, outfile: 'dist/js/app.js' },
  { name: 'worker', config: workerBuild, outfile: 'dist/js/app-worker.js' },
];

await Promise.all(shippedBuilds.map(({ name, config, outfile }) =>
  buildAndMinify(config, outfile, name)));

const shakaBundle = readFileSync('node_modules/shaka-player/dist/shaka-player.dash.js', 'utf8');
validateShakaBundle(shakaBundle);
writeFileSync('dist/js/shaka-player.dash.js', shakaBundle);

console.log('Compat gate: app and worker bundles are Chromium-38 clean.');

// Desktop-only HLS and MPEG-TS libraries. Shaka stays in its separate lazy
// bundle on both desktop and webOS.
if (isPreview) {
  await esbuild.build({
    entryPoints: ['src/preview-libs.ts'],
    bundle: true,
    format: FORMAT,
    target: TARGET,
    minify: true,
    outfile: 'dist/js/preview-libs.js',
    write: true,
  });
} else {
  rmSync('dist/js/preview-libs.js', { force: true });
}

console.log('Build complete.');
