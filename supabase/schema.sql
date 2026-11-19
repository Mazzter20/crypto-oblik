-- Крипто-облік: схема бази даних Supabase
-- Книги обліку (спільні групи), учасники, контрагенти та операції обміну UAH <-> USDT.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Профілі ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- Книги ----------
create table public.books (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invite_code text not null unique default upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8)),
  created_at timestamptz not null default now()
);

create table public.book_members (
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (book_id, user_id)
);
create index book_members_user_idx on public.book_members(user_id);

-- ---------- Контрагенти ----------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  rate numeric(14, 4) check (rate is null or rate > 0),
  note text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index contacts_book_idx on public.contacts(book_id);

-- ---------- Операції ----------
-- kind: uah_out  — я дав/переказав гривні
--       usdt_in  — мені кинули USDT
--       usdt_out — я кинув USDT
--       uah_in   — мені дали гривні
create table public.ops (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  kind text not null check (kind in ('uah_out', 'usdt_in', 'usdt_out', 'uah_in')),
  uah numeric(16, 2) not null check (uah >= 0),
  usdt numeric(18, 6) not null check (usdt >= 0),
  rate numeric(14, 4) generated always as (case when usdt > 0 then round(uah / usdt, 4) end) stored,
  method text not null default '' check (char_length(method) <= 40),
  method_detail text not null default '' check (char_length(method_detail) <= 80),
  op_date date not null default current_date,
  note text not null default '' check (char_length(note) <= 300),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index ops_book_idx on public.ops(book_id, op_date desc);
create index ops_contact_idx on public.ops(contact_id);
create index ops_created_by_idx on public.ops(created_by);
create index contacts_created_by_idx on public.contacts(created_by);
create index books_owner_idx on public.books(owner_id);

-- ---------- Допоміжні функції (у схемі private, не доступні через API) ----------
create schema if not exists private;
grant usage on schema private to authenticated;
create or replace function private.is_member(b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.book_members m where m.book_id = b and m.user_id = (select auth.uid()));
$$;

create or replace function private.is_owner(b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.books x where x.id = b and x.owner_id = (select auth.uid()));
$$;

create or replace function private.shares_book(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.book_members a
    join public.book_members b on a.book_id = b.book_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  );
$$;

-- Власник книги автоматично стає її учасником
create or replace function public.on_book_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.book_members(book_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end $$;
create trigger book_created after insert on public.books
  for each row execute function public.on_book_created();

-- Профіль при реєстрації
create or replace function public.on_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)))
  on conflict do nothing;
  return new;
end $$;
create trigger user_created after insert on auth.users
  for each row execute function public.on_user_created();

-- Приєднання до книги за кодом запрошення
create or replace function public.join_book(code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare b uuid;
begin
  if (select auth.uid()) is null then raise exception 'not_signed_in'; end if;
  select id into b from public.books where invite_code = upper(trim(code));
  if b is null then raise exception 'invalid_code'; end if;
  insert into public.book_members(book_id, user_id, role) values (b, (select auth.uid()), 'member')
  on conflict do nothing;
  return b;
end $$;

-- Новий код запрошення (тільки власник)
create or replace function public.rotate_invite(b uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare c text;
begin
  if not private.is_owner(b) then raise exception 'not_owner'; end if;
  c := upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8));
  update public.books set invite_code = c where id = b;
  return c;
end $$;

revoke execute on function public.join_book(text) from anon, public;
revoke execute on function public.rotate_invite(uuid) from anon, public;
grant execute on function public.join_book(text) to authenticated;
grant execute on function public.rotate_invite(uuid) to authenticated;
revoke execute on function public.on_book_created() from anon, authenticated, public;
revoke execute on function public.on_user_created() from anon, authenticated, public;
revoke execute on function private.is_member(uuid) from anon, public;
revoke execute on function private.is_owner(uuid) from anon, public;
revoke execute on function private.shares_book(uuid) from anon, public;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.is_owner(uuid) to authenticated;
grant execute on function private.shares_book(uuid) to authenticated;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.book_members enable row level security;
alter table public.contacts enable row level security;
alter table public.ops enable row level security;

create policy "profiles read own or co-members" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_book(id));
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "books read as member" on public.books for select to authenticated
  using (private.is_member(id) or owner_id = (select auth.uid()));
create policy "books create own" on public.books for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "books owner updates" on public.books for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "books owner deletes" on public.books for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "members read" on public.book_members for select to authenticated
  using (private.is_member(book_id));
create policy "members leave or owner removes" on public.book_members for delete to authenticated
  using ((user_id = (select auth.uid()) and role <> 'owner') or (private.is_owner(book_id) and role <> 'owner'));

create policy "contacts read" on public.contacts for select to authenticated
  using (private.is_member(book_id));
create policy "contacts insert" on public.contacts for insert to authenticated
  with check (private.is_member(book_id) and created_by = (select auth.uid()));
create policy "contacts update" on public.contacts for update to authenticated
  using (private.is_member(book_id)) with check (private.is_member(book_id));
create policy "contacts delete" on public.contacts for delete to authenticated
  using (created_by = (select auth.uid()) or private.is_owner(book_id));

-- ---------- Прив'язка людини до учасника книги ----------
-- Якщо контакт — це інший учасник книги (linked_user), він бачить операції зі свого боку:
-- «Я дав гривні» у того, хто записав, стає «Мені дали гривні» і борг — у нього.
alter table public.contacts add column linked_user uuid references auth.users(id) on delete set null;
create unique index contacts_book_linked_uniq on public.contacts(book_id, linked_user) where linked_user is not null;
create index contacts_linked_user_idx on public.contacts(linked_user);

create or replace function private.valid_link(b uuid, u uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select u is null or exists (select 1 from public.book_members m where m.book_id = b and m.user_id = u);
$$;
revoke execute on function private.valid_link(uuid, uuid) from anon, public;
grant execute on function private.valid_link(uuid, uuid) to authenticated;

drop policy "contacts insert" on public.contacts;
drop policy "contacts update" on public.contacts;
create policy "contacts insert" on public.contacts for insert to authenticated
  with check (private.is_member(book_id) and created_by = (select auth.uid())
    and linked_user is distinct from (select auth.uid()) and private.valid_link(book_id, linked_user));
create policy "contacts update" on public.contacts for update to authenticated
  using (private.is_member(book_id)) with check (private.is_member(book_id) and private.valid_link(book_id, linked_user));

create policy "ops read" on public.ops for select to authenticated
  using (private.is_member(book_id));
create policy "ops insert" on public.ops for insert to authenticated
  with check (private.is_member(book_id) and created_by = (select auth.uid())
    and exists (select 1 from public.contacts c where c.id = contact_id and c.book_id = ops.book_id));
create policy "ops update" on public.ops for update to authenticated
  using (created_by = (select auth.uid()) or private.is_owner(book_id))
  with check (private.is_member(book_id)
    and exists (select 1 from public.contacts c where c.id = contact_id and c.book_id = ops.book_id));
create policy "ops delete" on public.ops for delete to authenticated
  using (created_by = (select auth.uid()) or private.is_owner(book_id));
