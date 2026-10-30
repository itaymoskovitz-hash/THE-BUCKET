// Parsers for the Israeli price-transparency XML files (Victory "new source" format).
// Plain JS with no dependencies so it runs in Deno (Edge Function) and Node (tests).
// Tolerant on purpose: chains vary tag casing and nesting (Items/Item, Products/Product, Stores/Store).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read the leaf children of one XML element body into a lower-cased-key map. */
export function leafFields(body) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let m;
  while ((m = re.exec(body))) {
    const inner = m[2] ?? '';
    if (/<[A-Za-z_]/.test(inner)) continue; // not a leaf
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeXml(inner);
  }
  return out;
}

/** All occurrences of <tag>…</tag> (case-insensitive tag name), returning their bodies. */
export function elements(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

const rootField = (xml, names) => {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}>\\s*([^<]*?)\\s*</${n}>`, 'i'));
    if (m) return decodeXml(m[1]);
  }
  return null;
};

/** "077" → "77", "001" → "1"; keeps non-numeric IDs as they are. */
export const normStoreId = (s) => {
  const t = String(s ?? '').trim();
  return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t;
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const date = (v) => {
  if (!v) return null;
  const t = String(v).trim().replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + '+02:00');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Some Victory rows have a marketing blurb in ItemName and the real product name in
 * ManufactureItemDescription. Prefer whichever looks like a product name.
 */
function pickName(f) {
  const a = f.itemname || f.itemnm || '';
  const b = f.manufactureitemdescription || f.manufactureritemdescription || '';
  if (!a) return b;
  if (!b) return a;
  const looksLikeBlurb = (s) => /[.!]$/.test(s) || s.split(' ').length > 9;
  return looksLikeBlurb(a) && !looksLikeBlurb(b) ? b : a;
}

export function parsePriceXml(xml) {
  const chainId = rootField(xml, ['ChainId', 'ChainID']);
  const storeId = normStoreId(rootField(xml, ['StoreId', 'StoreID']));
  let rows = elements(xml, 'Item');
  if (!rows.length) rows = elements(xml, 'Product');
  const items = [];
  for (const body of rows) {
    const f = leafFields(body);
    const code = (f.itemcode || '').replace(/\s/g, '');
    const price = num(f.itemprice);
    const name = pickName(f);
    if (!code || !/^[0-9A-Za-z_-]{1,40}$/.test(code) || price == null || !name) continue;
    const other = (f.manufactureitemdescription || '') !== name ? f.manufactureitemdescription : f.itemname;
    items.push({
      item_code: code,
      name: name.slice(0, 200),
      description: other ? String(other).slice(0, 300) : null,
      manufacturer: (f.manufacturername || f.manufacturename || null)?.slice(0, 120) || null,
      quantity: num(f.quantity),
      unit_qty: f.unitqty || null,
      unit_of_measure: f.unitofmeasure || null,
      is_weighted: f.bisweighted === '1' || f.isweighted === '1',
      price,
      unit_price: num(f.unitofmeasureprice),
      price_updated_at: date(f.priceupdatedate || f.priceupdatetime),
    });
  }
  return { chainId, storeId, items };
}

export function parseStoresXml(xml) {
  const chainId = rootField(xml, ['ChainId', 'ChainID']);
  const stores = [];
  for (const body of elements(xml, 'Store')) {
    const f = leafFields(body);
    const id = normStoreId(f.storeid);
    if (!id || !f.storename) continue;
    stores.push({
      store_id: id,
      name: f.storename.slice(0, 120),
      city: f.city ? f.city.slice(0, 80) : null,
      address: f.address ? f.address.slice(0, 160) : null,
    });
  }
  return { chainId, stores };
}

/** File names look like PriceFull7290696200003-077-202610300600[-001].xml.gz */
export function parseFileName(name) {
  const m = String(name).match(/^(PriceFull|Price|PromoFull|Promo|StoresFull|Stores)(\d{13})-(\d{1,4})-(\d{8,14})/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), chainId: m[2], storeId: normStoreId(m[3]), stamp: m[4] };
}

/** Choose what to download: latest stores file per chain + latest full price file for each wanted branch. */
export function planDownloads(listing, wanted /* [{chain_id, store_id}] */) {
  const files = (Array.isArray(listing) ? listing : [listing])
    .map((e) => ({ e, meta: parseFileName(e?.fileName || e?.FileName || e?.name || '') }))
    .filter((x) => x.meta);
  const newest = (arr) => arr.sort((a, b) => b.meta.stamp.localeCompare(a.meta.stamp))[0];
  const plan = [];
  const chains = [...new Set(files.map((f) => f.meta.chainId))];
  for (const c of chains) {
    const st = newest(files.filter((f) => f.meta.chainId === c && f.meta.type === 'storesfull'))
      || newest(files.filter((f) => f.meta.chainId === c && f.meta.type === 'stores'));
    if (st) plan.push(st);
  }
  for (const w of wanted) {
    const pf = newest(files.filter((f) => f.meta.chainId === w.chain_id && f.meta.storeId === normStoreId(w.store_id) && f.meta.type === 'pricefull'));
    if (pf) plan.push(pf);
  }
  return plan.map(({ e, meta }) => ({ fileName: e.fileName || e.FileName || e.name, chainId: meta.chainId, type: meta.type, storeId: meta.storeId }));
}
