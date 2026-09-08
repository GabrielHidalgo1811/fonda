import { build } from 'esbuild';
import fs from 'node:fs/promises';
const publicConfig = JSON.parse(await fs.readFile('public-config.json', 'utf8'));
let localEnv = {};
try {
  localEnv = Object.fromEntries((await fs.readFile('.env', 'utf8')).split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#')).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const env = { ...publicConfig, ...localEnv, ...process.env };
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Falta la configuración pública de Supabase.');
}
await fs.mkdir('dist', { recursive: true });
await build({ entryPoints: ['js/app.js'], bundle: true, format: 'esm', target: ['es2022'],
  outfile: 'dist/app.js', minify: true, sourcemap: false });
await fs.copyFile('index.html', 'dist/index.html');
await fs.copyFile('favicon.png', 'dist/favicon.png');
await fs.writeFile('dist/config.js', `window.FIESTAS_CONFIG = ${JSON.stringify({
  supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
})};\n`);
await fs.mkdir('dist/css', { recursive: true });
await fs.copyFile('css/styles.css', 'dist/css/styles.css');
console.log('Aplicación compilada en dist/.');
