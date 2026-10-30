-- The Bucket — supermarket prices (Victory, from the official price-transparency files).
-- Price data is public information; it is readable by signed-in users and written only by the
-- price-ingest Edge Function (service role) after it checks a hashed ingest token.

create extension if not exists pg_trgm with schema extensions;

create table public.price_stores (
  chain_id    text not null,
  store_id    text not null,           -- normalized: no leading zeros
  name        text not null,
  city        text,
  address     text,
  updated_at  timestamptz not null default now(),
  primary key (chain_id, store_id)
);

create table public.price_products (
  chain_id          text not null,
  store_id          text not null,
  item_code         text not null,
  name              text not null,
  description       text,
  manufacturer      text,
  quantity          numeric,
  unit_qty          text,
  unit_of_measure   text,
  is_weighted       boolean not null default false,
  price             numeric(10,2) not null,
  unit_price        numeric(10,2),
  price_updated_at  timestamptz,
  imported_at       timestamptz not null default now(),
  primary key (chain_id, store_id, item_code),
  foreign key (chain_id, store_id) references public.price_stores(chain_id, store_id) on delete cascade
);
create index price_products_name_trgm on public.price_products using gin (name extensions.gin_trgm_ops);
create index price_products_desc_trgm on public.price_products using gin (description extensions.gin_trgm_ops);

-- which branch each family shops at
alter table public.families
  add column price_chain_id text,
  add column price_store_id text,
  add constraint families_price_store_fk foreign key (price_chain_id, price_store_id)
    references public.price_stores(chain_id, store_id) on delete set null;

-- an item on the list can be linked to a specific catalog product
alter table public.shopping_items
  add column item_code text check (item_code is null or item_code ~ '^[0-9A-Za-z_-]{1,40}$');

-- remembered choices: "חלב" in this family means product X
create table public.family_item_links (
  family_id  uuid not null references public.families(id) on delete cascade,
  name_key   text not null check (char_length(name_key) between 1 and 80),
  item_code  text not null check (item_code ~ '^[0-9A-Za-z_-]{1,40}$'),
  updated_at timestamptz not null default now(),
  primary key (family_id, name_key)
);

create table public.price_ingest_tokens (
  token_hash text primary key,
  label      text,
  created_at timestamptz not null default now()
);

create table public.price_import_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  kind      text not null,
  file_name text,
  rows      int,
  ok        boolean not null,
  detail    text
);

-- ── RLS ──
alter table public.price_stores        enable row level security;
alter table public.price_products      enable row level security;
alter table public.family_item_links   enable row level security;
alter table public.price_ingest_tokens enable row level security;
alter table public.price_import_log    enable row level security;

create policy price_stores_read   on public.price_stores   for select to authenticated using (true);
create policy price_products_read on public.price_products for select to authenticated using (true);

create policy links_select on public.family_item_links for select to authenticated using (public.is_family_member(family_id));
create policy links_insert on public.family_item_links for insert to authenticated with check (public.is_family_member(family_id));
create policy links_update on public.family_item_links for update to authenticated
  using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy links_delete on public.family_item_links for delete to authenticated using (public.is_family_member(family_id));
-- price_ingest_tokens / price_import_log: no policies → no access for anon/authenticated.

revoke all on public.price_stores, public.price_products, public.family_item_links,
              public.price_ingest_tokens, public.price_import_log from anon, authenticated;
grant select on public.price_stores, public.price_products to authenticated;
grant select, insert, update, delete on public.family_item_links to authenticated;

-- ── RPCs ──
create or replace function public.set_family_store(p_family_id uuid, p_chain_id text, p_store_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_family_owner(p_family_id) then raise exception 'NOT_OWNER'; end if;
  if p_store_id is not null and not exists (
       select 1 from public.price_stores where chain_id = p_chain_id and store_id = p_store_id) then
    raise exception 'STORE_NOT_FOUND';
  end if;
  update public.families
     set price_chain_id = case when p_store_id is null then null else p_chain_id end,
         price_store_id = p_store_id
   where id = p_family_id;
end $$;

create or replace function public.search_price_products(p_chain_id text, p_store_id text, p_query text, p_limit int default 20)
returns setof public.price_products
language sql stable security invoker set search_path = '' as $$
  with q as (select btrim(coalesce(p_query,'')) as t)
  select p.* from public.price_products p, q
   where p.chain_id = p_chain_id and p.store_id = p_store_id
     and char_length(q.t) >= 2
     and (p.name ilike '%' || q.t || '%' or p.description ilike '%' || q.t || '%'
          or extensions.similarity(p.name, q.t) > 0.25)
   order by (p.name ilike q.t || '%') desc,
            greatest(extensions.similarity(p.name, q.t), extensions.similarity(coalesce(p.description,''), q.t)) desc,
            p.price
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke execute on function public.set_family_store(uuid, text, text), public.search_price_products(text, text, text, int) from public, anon;
grant execute on function public.set_family_store(uuid, text, text), public.search_price_products(text, text, text, int) to authenticated;

-- families: direct updates are limited to the name column by the existing column grant,
-- so the store can only be changed through set_family_store (owner only).
