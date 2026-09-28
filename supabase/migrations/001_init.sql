-- 냉파 레시피 (chef-c) 초기 스키마
-- 사용자마다 자기 냉장고/레시피/양념만 보고 고칠 수 있고,
-- 관리자가 'PICK'으로 공개한 재료(쿠팡 파트너스 링크)는 누구나 볼 수 있다.

-- ── 관리자 ─────────────────────────────────────────────
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- 정책 없음: 클라이언트에서 직접 읽고 쓸 수 없음 (is_admin()으로만 확인)

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ── 재료 ──────────────────────────────────────────────
create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  qty text check (char_length(qty) <= 40),
  category text check (char_length(category) <= 20),
  expiry date,
  link text check (link is null or link = '' or link ~ '^https://'),
  in_fridge boolean not null default true,
  is_pick boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ingredients_user_idx on public.ingredients(user_id);
create index ingredients_pick_idx on public.ingredients(is_pick) where is_pick;
alter table public.ingredients enable row level security;

create policy "own ingredients readable" on public.ingredients
  for select to authenticated using (user_id = (select auth.uid()));
create policy "public picks readable" on public.ingredients
  for select to anon, authenticated using (is_pick and coalesce(link, '') <> '');
create policy "own ingredients insert" on public.ingredients
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (not is_pick or (select public.is_admin())));
create policy "own ingredients update" on public.ingredients
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (not is_pick or (select public.is_admin())));
create policy "own ingredients delete" on public.ingredients
  for delete to authenticated using (user_id = (select auth.uid()));

-- 공개 PICK 목록은 이 뷰로만 노출 (user_id, 수량, 유통기한 등은 숨김)
create view public.picks with (security_invoker = true) as
  select id, name, category, link, updated_at
  from public.ingredients
  where is_pick and coalesce(link, '') <> '';
grant select on public.picks to anon, authenticated;

-- ── 레시피 ────────────────────────────────────────────
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  minutes int check (minutes between 1 and 600),
  ingredients jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  why text check (char_length(why) <= 300),
  source text not null default 'mine' check (source in ('mine', 'ai')),
  created_at timestamptz not null default now()
);
create index recipes_user_idx on public.recipes(user_id);
alter table public.recipes enable row level security;
create policy "own recipes" on public.recipes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ── 기본 양념 ─────────────────────────────────────────
create table public.pantry (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  staples text[] not null default array['소금','설탕','후추','간장','식용유','참기름','다진마늘','고춧가루','물'],
  updated_at timestamptz not null default now()
);
alter table public.pantry enable row level security;
create policy "own pantry" on public.pantry
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ── AI 무료 사용량 (하루 단위) ───────────────────────
create table public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default (now() at time zone 'Asia/Seoul')::date,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
create policy "own usage readable" on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));

-- Edge Function(service_role)만 호출: 한도 안이면 1 증가 후 true
create or replace function public.consume_ai_quota(p_user uuid, p_limit int)
returns int  -- 증가 후 사용 횟수, 한도 초과면 -1
language plpgsql security definer set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_count int;
begin
  insert into public.ai_usage (user_id, day, count) values (p_user, v_day, 1)
  on conflict (user_id, day) do update
    set count = public.ai_usage.count + 1
    where public.ai_usage.count < p_limit
  returning count into v_count;
  return coalesce(v_count, -1);
end;
$$;
revoke all on function public.consume_ai_quota(uuid, int) from public, anon, authenticated;

-- ── updated_at 자동 갱신 ─────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
create trigger ingredients_touch before update on public.ingredients
  for each row execute function public.touch_updated_at();
create trigger pantry_touch before update on public.pantry
  for each row execute function public.touch_updated_at();
