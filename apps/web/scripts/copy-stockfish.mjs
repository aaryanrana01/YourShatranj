// Copies the single-threaded "lite" Stockfish build into public/ so the browser
// can load it as a Web Worker. Single-threaded = no SharedArrayBuffer, so no
// special cross-origin-isolation headers are needed on any host.
// The files are renamed to stockfish.js / stockfish.wasm: the engine finds its
// .wasm by swapping the extension of its own URL.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('stockfish/package.json'));
const srcDir = path.join(pkgDir, 'src');
const outDir = path.resolve(here, '../public/stockfish');

const js = readdirSync(srcDir).find((f) => /^stockfish-.*-lite-single-[0-9a-f]+\.js$/.test(f));
if (!js) throw new Error('lite-single Stockfish build not found in the stockfish package');
const wasm = js.replace(/\.js$/, '.wasm');

mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(srcDir, js), path.join(outDir, 'stockfish.js'));
copyFileSync(path.join(srcDir, wasm), path.join(outDir, 'stockfish.wasm'));
// Stockfish is GPLv3: ship its licence next to the binary.
if (existsSync(path.join(pkgDir, 'Copying.txt'))) {
  copyFileSync(path.join(pkgDir, 'Copying.txt'), path.join(outDir, 'COPYING.txt'));
}
console.log(`Stockfish copied: ${js} -> public/stockfish/stockfish.js`);
