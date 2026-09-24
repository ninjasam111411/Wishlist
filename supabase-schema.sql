-- Wishlist database schema for Supabase
-- Run this once in the Supabase SQL Editor (Database > SQL Editor > New query),
-- against a brand-new project, before filling in config.js.
--
-- IMPORTANT ORDERING NOTE: every table below must exist before any
-- row-level security (RLS) policy is created, because a policy on one
-- table can reference another table. This file is already ordered
-- correctly -- run it top to bottom in one go.

-- ============================================================
-- 1. Extensions
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- 2. Tables
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  first_name text,
  last_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique default substr(md5(random()::text), 1, 8),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  nickname text,
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text,
  link text,
  image_url text,
  -- Who marked this item as bought, and when. Never exposed to the
  -- item's own owner (see wishlist_items_view below) -- that's what
  -- keeps it a surprise.
  purchased_by uuid references public.profiles (id) on delete set null,
  purchased_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 3. Helper functions (SECURITY DEFINER, used by policies below)
-- ============================================================
--
-- Several policies below need to know "which groups is the current user
-- a member of". Querying public.group_members directly from inside a
-- policy on public.group_members itself (or from a policy on a table
-- that then queries group_members, which has its own RLS-protected
-- self-referencing policy) makes Postgres detect a recursive loop and
-- refuse with "infinite recursion detected in policy for relation
-- \"group_members\"". Wrapping the lookup in a SECURITY DEFINER function
-- avoids this: the function runs with its owner's privileges (the table
-- owner), so the query inside it is not subject to row-level security,
-- and the loop never happens.

create or replace function public.get_my_group_ids()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select group_id from public.group_members where user_id = auth.uid();
$$;

create or replace function public.get_my_groupmate_ids()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select distinct user_id from public.group_members
  where group_id in (select group_id from public.group_members where user_id = auth.uid());
$$;

-- ============================================================
-- 4. Row-level security (created AFTER every table above exists)
-- ============================================================
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.wishlist_items enable row level security;

create policy "profiles are visible to groupmates"
  on public.profiles for select
  using (
    id = auth.uid()
    or id in (select public.get_my_groupmate_ids())
  );

create policy "users can update their own profile"
  on public.profiles for update
  using (id = auth.uid());

-- Any signed-in user can view the groups table (id, name, invite_code,
-- created_by, created_at). This is intentional, not an oversight: joining
-- a group works by looking a group up by its invite code before you are
-- a member of it (the "Have an invite code?" box on the dashboard), so
-- membership-gated visibility here would make joining impossible. The
-- invite code itself -- not row-level security on this table -- is what
-- actually gates who can join a group. The sensitive data (who's in a
-- group, and what's on their wishlist) stays properly restricted to
-- members only, in the policies below.
create policy "authenticated users can view groups"
  on public.groups for select
  using (auth.uid() is not null);

create policy "any signed-in user can create a group"
  on public.groups for insert
  with check (auth.uid() is not null);

create policy "members can view their groups' membership"
  on public.group_members for select
  using (
    group_id in (select public.get_my_group_ids())
  );

create policy "a user can add themselves to a group (join by invite code)"
  on public.group_members for insert
  with check (user_id = auth.uid());

create policy "a user can remove themselves from a group (leave)"
  on public.group_members for delete
  using (user_id = auth.uid());

create policy "a member can update their own membership row (nickname)"
  on public.group_members for update
  using (user_id = auth.uid());

create policy "members can view items in their groups"
  on public.wishlist_items for select
  using (
    group_id in (select public.get_my_group_ids())
  );

create policy "a member can add items to their own wishlist"
  on public.wishlist_items for insert
  with check (
    user_id = auth.uid()
    and group_id in (select public.get_my_group_ids())
  );

create policy "a member can edit their own items"
  on public.wishlist_items for update
  using (user_id = auth.uid());

create policy "a member can delete their own items"
  on public.wishlist_items for delete
  using (user_id = auth.uid());

-- ============================================================
-- 5. Auto-create a profile row whenever someone signs up
-- ============================================================
-- first_name/last_name come from the extra data passed to
-- supabase.auth.signUp({ options: { data: { first_name, last_name } } }).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
-- ============================================================
-- 6. Purchase tracking, hidden from the item's own wisher
-- ============================================================
-- A security_invoker view: it enforces the querying user's own RLS on the
-- underlying tables (so you still only ever see items in groups you belong
-- to), but additionally nulls out the purchase columns whenever the viewer
-- is the item's own owner -- so the person an item is for can never see,
-- via this view, whether it's been bought. The app reads through this view;
-- writes (insert/delete of items) still go through the plain table, and
-- purchase marking goes through the two RPC functions below.
create or replace view public.wishlist_items_view
with (security_invoker = true)
as
select
  wi.id,
  wi.group_id,
  wi.user_id,
  wi.name,
  wi.description,
  wi.link,
  wi.image_url,
  wi.created_at,
  case when wi.user_id = auth.uid() then null else wi.purchased_by end as purchased_by,
  case when wi.user_id = auth.uid() then null else wi.purchased_at end as purchased_at,
  case when wi.user_id = auth.uid() then null else p.first_name end as purchased_by_first_name,
  case when wi.user_id = auth.uid() then null else p.last_name end as purchased_by_last_name
from public.wishlist_items wi
left join public.profiles p on p.id = wi.purchased_by;

grant select on public.wishlist_items_view to authenticated;

-- Marking an item purchased: only a fellow group member (never the item's
-- own owner) can do this, and only once (first to mark it wins).
create or replace function public.mark_item_purchased(target_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
begin
  select * into item from public.wishlist_items where id = target_item_id;
  if item is null then
    raise exception 'Item not found';
  end if;

  if item.user_id = auth.uid() then
    raise exception 'You cannot mark your own item as bought';
  end if;

  if item.group_id not in (select public.get_my_group_ids()) then
    raise exception 'You are not a member of this group';
  end if;

  if item.purchased_by is not null then
    raise exception 'This item has already been marked as bought';
  end if;

  update public.wishlist_items
  set purchased_by = auth.uid(), purchased_at = now()
  where id = target_item_id;
end;
$$;

-- Undoing a purchase mark: only the person who marked it can undo it.
create or replace function public.unmark_item_purchased(target_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
begin
  select * into item from public.wishlist_items where id = target_item_id;
  if item is null then
    raise exception 'Item not found';
  end if;

  if item.purchased_by is distinct from auth.uid() then
    raise exception 'Only the person who marked this as bought can undo it';
  end if;

  update public.wishlist_items
  set purchased_by = null, purchased_at = null
  where id = target_item_id;
end;
$$;

revoke all on function public.mark_item_purchased(uuid) from public;
revoke all on function public.unmark_item_purchased(uuid) from public;
grant execute on function public.mark_item_purchased(uuid) to authenticated;
grant execute on function public.unmark_item_purchased(uuid) to authenticated;

-- ============================================================
-- 7. Owner-assisted "add by name" joining
-- ============================================================

-- Search everyone's name (not gated to groupmates -- you need to be able
-- to find someone BEFORE they're in any group with you). Returns only
-- name + email, never anything sensitive.
create or replace function public.search_profiles_by_name(query text)
returns table(id uuid, first_name text, last_name text, email text)
language sql
security definer
set search_path = public
stable
as $$
  select id, first_name, last_name, email
  from public.profiles
  where
    query is not null and length(trim(query)) > 0
    and (
      first_name ilike '%' || query || '%'
      or last_name ilike '%' || query || '%'
      or coalesce(first_name || ' ' || last_name, '') ilike '%' || query || '%'
    )
  limit 20;
$$;

-- Only the group's creator (owner) can add someone directly this way.
create or replace function public.add_group_member_by_id(target_group_id uuid, target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grp record;
  target_profile record;
begin
  select * into grp from public.groups where id = target_group_id;
  if grp is null then
    raise exception 'Group not found';
  end if;

  if grp.created_by is distinct from auth.uid() then
    raise exception 'Only the group owner can add members this way';
  end if;

  select * into target_profile from public.profiles where id = target_user_id;
  if target_profile is null then
    raise exception 'That person could not be found';
  end if;

  insert into public.group_members (group_id, user_id)
  values (target_group_id, target_user_id)
  on conflict (group_id, user_id) do nothing;
end;
$$;

revoke all on function public.search_profiles_by_name(text) from public;
revoke all on function public.add_group_member_by_id(uuid, uuid) from public;
grant execute on function public.search_profiles_by_name(text) to authenticated;
grant execute on function public.add_group_member_by_id(uuid, uuid) to authenticated;

-- ============================================================
-- 8. Push notification subscriptions
-- ============================================================
-- One row per browser/device that has turned on "Notify me when someone
-- adds an item" in Settings. The app itself only ever inserts/deletes
-- its own rows (policies below); api/send-item-notification.js reads
-- across users with the service_role key, which bypasses RLS entirely,
-- to actually find who to notify.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "a user can view their own push subscriptions"
  on public.push_subscriptions for select
  using (user_id = auth.uid());

create policy "a user can add their own push subscription"
  on public.push_subscriptions for insert
  with check (user_id = auth.uid());

create policy "a user can remove their own push subscription"
  on public.push_subscriptions for delete
  using (user_id = auth.uid());

-- ============================================================
-- 9. Owner-only group management: rename, remove a member,
--    transfer ownership, regenerate the invite code, delete the group
-- ============================================================
-- Renaming is a plain client-side `.update()` on the groups table (see
-- app.js), so it needs its own RLS policy; deleting a group is likewise
-- a plain `.delete()`. Removing a member, transferring ownership, and
-- regenerating the invite code go through SECURITY DEFINER functions
-- below instead, since each needs to check things RLS alone can't
-- (who the target member is, that a new owner is actually a member).

create policy "the owner can rename their group"
  on public.groups for update
  using (created_by = auth.uid());

create policy "the owner can delete their group"
  on public.groups for delete
  using (created_by = auth.uid());

-- Only the group's owner can remove someone else from the group this
-- way; removing yourself is "Leave this group" in Settings instead, and
-- an owner can't remove themselves here (they'd transfer ownership or
-- delete the group instead).
create or replace function public.remove_group_member(target_group_id uuid, target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grp record;
begin
  select * into grp from public.groups where id = target_group_id;
  if grp is null then
    raise exception 'Group not found';
  end if;

  if grp.created_by is distinct from auth.uid() then
    raise exception 'Only the group owner can remove members';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'Use "Leave this group" to remove yourself';
  end if;

  delete from public.group_members
  where group_id = target_group_id and user_id = target_user_id;
end;
$$;

-- Hands ownership of a group to another current member. The new owner
-- must already be a member; the caller must be the current owner.
create or replace function public.transfer_group_ownership(target_group_id uuid, new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grp record;
  is_member boolean;
begin
  select * into grp from public.groups where id = target_group_id;
  if grp is null then
    raise exception 'Group not found';
  end if;

  if grp.created_by is distinct from auth.uid() then
    raise exception 'Only the group owner can transfer ownership';
  end if;

  select exists(
    select 1 from public.group_members
    where group_id = target_group_id and user_id = new_owner_id
  ) into is_member;
  if not is_member then
    raise exception 'That person is not a member of this group';
  end if;

  update public.groups set created_by = new_owner_id where id = target_group_id;
end;
$$;

-- Generates a fresh invite code for the group (the old one stops
-- working immediately) and returns it. Owner only.
create or replace function public.regenerate_invite_code(target_group_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  grp record;
  new_code text;
begin
  select * into grp from public.groups where id = target_group_id;
  if grp is null then
    raise exception 'Group not found';
  end if;

  if grp.created_by is distinct from auth.uid() then
    raise exception 'Only the group owner can regenerate the invite code';
  end if;

  new_code := substr(md5(random()::text), 1, 8);
  update public.groups set invite_code = new_code where id = target_group_id;
  return new_code;
end;
$$;

revoke all on function public.remove_group_member(uuid, uuid) from public;
revoke all on function public.transfer_group_ownership(uuid, uuid) from public;
revoke all on function public.regenerate_invite_code(uuid) from public;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.transfer_group_ownership(uuid, uuid) to authenticated;
grant execute on function public.regenerate_invite_code(uuid) to authenticated;
