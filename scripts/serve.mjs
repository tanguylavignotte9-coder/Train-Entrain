import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.map': 'application/json' };
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  const p = (req.url || '/').split('?')[0];
  try { const d = await readFile(join(root, p === '/' ? 'index.html' : p)); res.writeHead(200, { 'Content-Type': types[extname(p === '/' ? '.html' : p)] || 'application/octet-stream' }); res.end(d); }
  catch { res.writeHead(404); res.end('404'); }
}).listen(port, () => console.log(`Train Entrain (mode navigateur) : http://localhost:${port}`));
