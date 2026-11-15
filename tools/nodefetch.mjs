// Lets docs/core.js run under Node: index files are read from disk, everything else goes over HTTP as usual.
import { readFileSync } from 'node:fs';

const http = globalThis.fetch;
globalThis.fetch = (url, opt) => {
  if (!String(url).startsWith('file:')) return http(url, opt);
  try {
    const text = readFileSync(new URL(url), 'utf8');
    return Promise.resolve({ ok: true, json: async () => JSON.parse(text) });
  } catch { return Promise.resolve({ ok: false }); }
};
export const WEB = new URL('../docs/', import.meta.url);
export const readJson = (name) => JSON.parse(readFileSync(new URL(name, WEB), 'utf8'));

// Run `job` over `items` with at most `limit` running at once.
export async function pool(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { for (let k; (k = next++) < items.length;) out[k] = await job(items[k], k); }));
  return out;
}
