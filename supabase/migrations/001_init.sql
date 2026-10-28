-- The Bucket — initial schema, RLS and trusted RPC functions.
-- All membership changes go through SECURITY DEFINER functions below;
-- there are NO direct insert/update/delete policies on family_members or family_invitations.

-- ───────────────────────── Tables ─────────────────────────

create table public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  created_by  uuid not null references auth.users(id) on delete restrict,
  created_at  timestamptz not null default now()
);

create table public.family_members (
  family_id  uuid not null references public.families(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','member')),
  joined_at  timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index family_members_user_idx on public.family_members(user_id);
-- exactly one owner per family
create unique index family_members_one_owner on public.family_members(family_id) where role = 'owner';

create table public.shopping_items (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  quantity      text check (quantity is null or char_length(quantity) <= 20),
  category      smallint not null default 12 check (category between 1 and 12),
  purchased     boolean not null default false,
  purchased_at  timestamptz,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  client_ref    uuid unique,           -- idempotency key from the client (prevents double-submit duplicates)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index shopping_items_family_idx on public.shopping_items(family_id, purchased, category);

create table public.family_invitations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  email        text not null check (email = lower(btrim(email))),
  token_hash   text not null unique,
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null,
  revoked_at   timestamptz
);
create index family_invitations_family_idx on public.family_invitations(family_id);

-- ───────────────────────── Helpers ─────────────────────────

create or replace function public.is_family_member(p_family_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members m
                 where m.family_id = p_family_id and m.user_id = auth.uid());
$$;

create or replace function public.is_family_owner(p_family_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members m
                 where m.family_id = p_family_id and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- items: keep timestamps server-side, forbid moving items between families or rewriting authorship
create or replace function public.shopping_items_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.quantity := nullif(btrim(coalesce(new.quantity,'')), '');
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.id := old.id;
    new.family_id := old.family_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.client_ref := old.client_ref;
  end if;
  new.updated_at := now();
  if new.purchased and (tg_op = 'INSERT' or not old.purchased) then
    new.purchased_at := now();
  elsif not new.purchased then
    new.purchased_at := null;
  else
    new.purchased_at := old.purchased_at;
  end if;
  return new;
end $$;

create trigger shopping_items_before_write
before insert or update on public.shopping_items
for each row execute function public.shopping_items_before_write();

-- families: only the name may change through direct updates
create or replace function public.families_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.id := old.id; new.created_by := old.created_by; new.created_at := old.created_at;
  new.name := btrim(new.name);
  return new;
end $$;
create trigger families_before_update before update on public.families
for each row execute function public.families_before_update();

-- ───────────────────────── RLS ─────────────────────────

alter table public.families           enable row level security;
alter table public.family_members     enable row level security;
alter table public.shopping_items     enable row level security;
alter table public.family_invitations enable row level security;

create policy families_select on public.families for select to authenticated
  using (public.is_family_member(id));
create policy families_update on public.families for update to authenticated
  using (public.is_family_owner(id)) with check (public.is_family_owner(id));

create policy family_members_select on public.family_members for select to authenticated
  using (public.is_family_member(family_id));

create policy items_select on public.shopping_items for select to authenticated
  using (public.is_family_member(family_id));
create policy items_insert on public.shopping_items for insert to authenticated
  with check (public.is_family_member(family_id));
create policy items_update on public.shopping_items for update to authenticated
  using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy items_delete on public.shopping_items for delete to authenticated
  using (public.is_family_member(family_id));

create policy invitations_select on public.family_invitations for select to authenticated
  using (public.is_family_owner(family_id));

-- Table-level privileges: anon gets nothing; authenticated only what RLS then filters.
revoke all on public.families, public.family_members, public.shopping_items, public.family_invitations from anon, authenticated;
grant select, update (name) on public.families to authenticated;
grant select on public.family_members to authenticated;
grant select, insert, update, delete on public.shopping_items to authenticated;
grant select (id, family_id, email, created_at, expires_at, accepted_at, revoked_at) on public.family_invitations to authenticated;

-- ───────────────────────── Trusted RPCs ─────────────────────────

create or replace function public.create_family(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then raise exception 'INVALID_NAME'; end if;
  insert into public.families(name, created_by) values (btrim(p_name), v_uid) returning id into v_id;
  insert into public.family_members(family_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end $$;

create or replace function public.list_family_members(p_family_id uuid)
returns table(user_id uuid, email text, role text, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_family_member(p_family_id) then raise exception 'NOT_A_MEMBER'; end if;
  return query
    select m.user_id, u.email::text, m.role, m.joined_at
    from public.family_members m join auth.users u on u.id = m.user_id
    where m.family_id = p_family_id
    order by (m.role = 'owner') desc, m.joined_at;
end $$;

create or replace function public.create_invitation(p_family_id uuid, p_email text)
returns table(invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email,''))); v_token text; v_id uuid; v_exp timestamptz;
begin
  if not public.is_family_owner(p_family_id) then raise exception 'NOT_OWNER'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then raise exception 'INVALID_EMAIL'; end if;
  if exists (select 1 from public.family_members m join auth.users u on u.id = m.user_id
             where m.family_id = p_family_id and lower(u.email) = v_email) then
    raise exception 'ALREADY_MEMBER';
  end if;
  -- one live invitation per email per family
  update public.family_invitations i set revoked_at = now()
   where i.family_id = p_family_id and i.email = v_email
     and i.accepted_at is null and i.revoked_at is null;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.family_invitations(family_id, email, token_hash, invited_by)
  values (p_family_id, v_email, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning id, family_invitations.expires_at into v_id, v_exp;
  return query select v_id, v_token, v_exp;
end $$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_family uuid;
begin
  select family_id into v_family from public.family_invitations where id = p_invitation_id;
  if v_family is null or not public.is_family_owner(v_family) then raise exception 'NOT_OWNER'; end if;
  update public.family_invitations set revoked_at = now()
   where id = p_invitation_id and accepted_at is null and revoked_at is null;
end $$;

create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_inv public.family_invitations%rowtype; v_email text; v_confirmed timestamptz;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'INVITE_INVALID'; end if;
  select * into v_inv from public.family_invitations
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') for update;
  if not found then raise exception 'INVITE_INVALID'; end if;
  if v_inv.revoked_at is not null then raise exception 'INVITE_REVOKED'; end if;
  if v_inv.accepted_at is not null then raise exception 'INVITE_USED'; end if;
  if v_inv.expires_at <= now() then raise exception 'INVITE_EXPIRED'; end if;
  select lower(email), email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  if v_confirmed is null then raise exception 'EMAIL_NOT_CONFIRMED'; end if;
  if v_email is distinct from v_inv.email then raise exception 'INVITE_WRONG_EMAIL'; end if;
  if exists (select 1 from public.family_members where family_id = v_inv.family_id and user_id = v_uid) then
    raise exception 'ALREADY_MEMBER';
  end if;
  insert into public.family_members(family_id, user_id, role) values (v_inv.family_id, v_uid, 'member');
  update public.family_invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.family_id;
end $$;

create or replace function public.remove_member(p_family_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_family_owner(p_family_id) then raise exception 'NOT_OWNER'; end if;
  if p_user_id = auth.uid() then raise exception 'CANNOT_REMOVE_SELF'; end if;
  delete from public.family_members where family_id = p_family_id and user_id = p_user_id;
end $$;

create or replace function public.leave_family(p_family_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_family_member(p_family_id) then raise exception 'NOT_A_MEMBER'; end if;
  if public.is_family_owner(p_family_id) then raise exception 'OWNER_CANNOT_LEAVE'; end if;
  delete from public.family_members where family_id = p_family_id and user_id = auth.uid();
end $$;

create or replace function public.transfer_ownership(p_family_id uuid, p_new_owner uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_family_owner(p_family_id) then raise exception 'NOT_OWNER'; end if;
  if p_new_owner = auth.uid() then raise exception 'ALREADY_OWNER'; end if;
  if not exists (select 1 from public.family_members where family_id = p_family_id and user_id = p_new_owner) then
    raise exception 'NOT_A_MEMBER';
  end if;
  update public.family_members set role = 'member' where family_id = p_family_id and user_id = auth.uid();
  update public.family_members set role = 'owner'  where family_id = p_family_id and user_id = p_new_owner;
end $$;

create or replace function public.delete_family(p_family_id uuid, p_confirm_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not public.is_family_owner(p_family_id) then raise exception 'NOT_OWNER'; end if;
  select name into v_name from public.families where id = p_family_id;
  if v_name is distinct from btrim(coalesce(p_confirm_name,'')) then raise exception 'CONFIRM_MISMATCH'; end if;
  delete from public.families where id = p_family_id;
end $$;

-- Function privileges: only signed-in users may call the RPCs.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.is_family_member(uuid), public.is_family_owner(uuid),
  public.create_family(text), public.list_family_members(uuid),
  public.create_invitation(uuid, text), public.revoke_invitation(uuid),
  public.accept_invitation(text), public.remove_member(uuid, uuid),
  public.leave_family(uuid), public.transfer_ownership(uuid, uuid),
  public.delete_family(uuid, text)
to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- ───────────────────────── Realtime ─────────────────────────
alter publication supabase_realtime add table public.shopping_items;
