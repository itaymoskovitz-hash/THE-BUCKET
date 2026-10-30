// price-ingest — receives Victory price-transparency files relayed by the updater on a computer in Israel
// (the chain's file server only accepts Israeli connections), parses them and stores them.
//
//   POST /price-ingest/plan          body: getfiles listing JSON  → which files to fetch
//   POST /price-ingest/file?name=…   body: the raw .gz (or .xml) file → parsed + upserted
//   GET  /price-ingest/status        → last imports (for the updater's log)
//
// Every call needs header  x-ingest-token: <token>. Only its SHA-256 is stored (public.price_ingest_tokens).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parsePriceXml, parseStoresXml, parseFileName, planDownloads } from './parse.js';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function authorized(req: Request) {
  const t = req.headers.get('x-ingest-token') || '';
  if (!/^[0-9a-f]{64}$/.test(t)) return false;
  const { data } = await db.from('price_ingest_tokens').select('token_hash').eq('token_hash', await sha256(t)).maybeSingle();
  return !!data;
}
async function log(kind: string, file_name: string | null, rows: number | null, ok: boolean, detail?: string) {
  await db.from('price_import_log').insert({ kind, file_name, rows, ok, detail: detail?.slice(0, 500) ?? null });
}

async function toText(bytes: Uint8Array) {
  let data = bytes;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
    data = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  return new TextDecoder('utf-8').decode(data);
}

async function upsertChunks(table: string, rows: Record<string, unknown>[], onConflict: string, size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop();
  if (!(await authorized(req))) return json({ error: 'unauthorized' }, 401);

  try {
    if (action === 'status') {
      const { data } = await db.from('price_import_log').select('*').order('id', { ascending: false }).limit(20);
      return json({ log: data });
    }

    if (action === 'plan' && req.method === 'POST') {
      const listing = await req.json();
      const { data: fams, error } = await db.from('families')
        .select('price_chain_id, price_store_id').not('price_store_id', 'is', null);
      if (error) throw error;
      const wanted = [...new Map((fams ?? []).map((f) => [`${f.price_chain_id}|${f.price_store_id}`,
        { chain_id: f.price_chain_id, store_id: f.price_store_id }])).values()];
      const fetch = planDownloads(listing, wanted);
      await log('plan', null, fetch.length, true, `listing=${Array.isArray(listing) ? listing.length : 1} wanted=${wanted.length}`);
      return json({ fetch, wanted });
    }

    if (action === 'file' && req.method === 'POST') {
      const name = url.searchParams.get('name') || '';
      const meta = parseFileName(name);
      if (!meta) return json({ error: 'bad file name' }, 400);
      let xml: string;
      if ((req.headers.get('content-type') || '').includes('application/json')) {
        // JSON form (used by tests): { xml } or { gz_b64 }
        const b = await req.json();
        xml = b?.gz_b64 ? await toText(Uint8Array.from(atob(String(b.gz_b64)), (c) => c.charCodeAt(0))) : String(b?.xml ?? '');
      } else {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length < 20 || bytes.length > 40 * 1024 * 1024) return json({ error: 'bad size' }, 400);
        xml = await toText(bytes);
      }
      if (xml.length < 20) return json({ error: 'empty file' }, 400);
      const startedAt = new Date().toISOString();

      if (meta.type === 'storesfull' || meta.type === 'stores') {
        const { chainId, stores } = parseStoresXml(xml);
        const chain = chainId || meta.chainId;
        const rows = [...new Map(stores.map((s) => [s.store_id, { ...s, chain_id: chain, updated_at: startedAt }])).values()];
        await upsertChunks('price_stores', rows, 'chain_id,store_id');
        await log(meta.type, name, rows.length, true);
        return json({ ok: true, type: meta.type, stores: rows.length });
      }

      if (meta.type === 'pricefull' || meta.type === 'price') {
        const { chainId, storeId, items } = parsePriceXml(xml);
        const chain = chainId || meta.chainId;
        const store = storeId || meta.storeId;
        // make sure the branch row exists (stores file may be missing that day)
        const { data: st } = await db.from('price_stores').select('store_id').eq('chain_id', chain).eq('store_id', store).maybeSingle();
        if (!st) await db.from('price_stores').insert({ chain_id: chain, store_id: store, name: `סניף ${store}` });
        // de-duplicate by item code (an upsert batch may not touch the same row twice)
        const rows = [...new Map(items.map((it) => [it.item_code,
          { ...it, chain_id: chain, store_id: store, imported_at: startedAt }])).values()];
        await upsertChunks('price_products', rows, 'chain_id,store_id,item_code');
        if (meta.type === 'pricefull' && rows.length > 50) {
          // drop products that are no longer in this branch's full file
          await db.from('price_products').delete().eq('chain_id', chain).eq('store_id', store).lt('imported_at', startedAt);
        }
        await log(meta.type, name, rows.length, true);
        return json({ ok: true, type: meta.type, store, items: rows.length });
      }

      return json({ ok: true, skipped: meta.type });
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    await log(action || 'error', url.searchParams.get('name'), null, false, String(e?.message ?? e));
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
