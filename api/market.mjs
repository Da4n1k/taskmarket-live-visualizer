import { gzipSync } from 'node:zlib';
import { CACHE_CONTROL_HEADER, getMarketData } from '../lib/market-data.mjs';

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const { payload, cacheStatus } = await getMarketData();
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const acceptEnc = String(req.headers?.['accept-encoding'] || '');
    const useGzip = acceptEnc.includes('gzip');
    const out = useGzip ? gzipSync(body, { level: 6 }) : body;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', CACHE_CONTROL_HEADER);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('X-Cache-Status', cacheStatus);
    res.setHeader('X-Data-As-Of', payload.meta.dataAsOf);
    if (useGzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(out.length));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(out);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        error: 'Upstream market API unavailable',
        detail: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
