-- Dex: Supabase schema. Paste into the SQL editor of a new Supabase project.
-- Enables phone <-> desktop sync and the live companion link.

create table if not exists public.artists (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  name text not null,
  status text not null default 'unknown',
  reason text,
  favourite int,
  style text,
  note text,
  binder_page int,
  updated_at bigint not null,
  primary key (user_id, key)
);

create table if not exists public.binder_pages (
  user_id uuid not null references auth.users(id) on delete cascade,
  page int not null,
  artist_key text,
  updated_at bigint not null,
  primary key (user_id, page)
);

create table if not exists public.owned_cards (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null,
  bucket text not null default 'bulk',
  qty int not null default 1,
  added_at bigint not null,
  updated_at bigint not null,
  deleted int default 0
);

create index if not exists owned_cards_user_updated on public.owned_cards (user_id, updated_at);
create index if not exists artists_user_updated on public.artists (user_id, updated_at);
create index if not exists binder_pages_user_updated on public.binder_pages (user_id, updated_at);

alter table public.artists enable row level security;
alter table public.binder_pages enable row level security;
alter table public.owned_cards enable row level security;

create policy "own rows" on public.artists for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.binder_pages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.owned_cards for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime: Database > Replication > enable for these three tables (or run):
alter publication supabase_realtime add table public.artists, public.binder_pages, public.owned_cards;
