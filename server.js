import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'dist');
const files = new Set(['index.html', 'app.js', 'config.js', 'favicon.png', 'css/styles.css']);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!files.has(file)) { res.writeHead(404); return res.end('No encontrado'); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      const content = await fs.readFile(path.join(publicDir, file));
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] + (path.extname(file) === '.png' ? '' : '; charset=utf-8'), 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 503 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ejecuta npm run build antes de iniciar el servidor.');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log('Fondeando AURA disponible en http://' + host + ':' + port));
}
