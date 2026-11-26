import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(__dirname, '../public/index.html');

const rawUrl = process.argv[2];
if (!rawUrl || !/^https:\/\/[a-z0-9.-]+/i.test(rawUrl)) {
  console.error('Usage: node scripts/set-site-url.mjs https://your-deployed-domain.vercel.app');
  process.exit(1);
}

const siteUrl = rawUrl.replace(/\/+$/, '');
let html = await readFile(INDEX_HTML, 'utf8');
html = html.replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${siteUrl}/" />`);
html = html.replace(/<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${siteUrl}/og-image.png" />`);
html = html.replace(/<meta name="twitter:image" content="[^"]*" \/>/, `<meta name="twitter:image" content="${siteUrl}/og-image.png" />`);
await writeFile(INDEX_HTML, html, 'utf8');
console.log(`Updated OG/Twitter canonical URLs in public/index.html to ${siteUrl}`);
