-- =====================================================================
-- Chat Nội Bộ — Supabase setup
-- Chạy toàn bộ file này 1 lần trong Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- Bảng người dùng ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  email text,
  color text,
  created_at timestamptz not null default now()
);

-- Mã mời: đặt invite_code để chỉ người có mã mới đăng ký được (null = ai cũng đăng ký được)
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  invite_code text
);
insert into public.app_settings (id, invite_code) values (1, null) on conflict (id) do nothing;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_colors text[] := array['#0084ff','#e84393','#00b894','#fd7e14','#6c5ce7','#d63031','#0abde3','#10ac84','#c56cf0','#ff9f43'];
begin
  select invite_code into v_code from public.app_settings where id = 1;
  if coalesce(v_code, '') <> '' and coalesce(new.raw_user_meta_data->>'invite_code', '') <> v_code then
    raise exception 'INVALID_INVITE_CODE';
  end if;

  insert into public.profiles (id, display_name, email, color)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    v_colors[1 + floor(random() * array_length(v_colors, 1))::int]
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Hội thoại / thành viên / tin nhắn ----------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  name text,
  is_group boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations on delete cascade,
  sender_id uuid not null references public.profiles on delete cascade default auth.uid(),
  kind text not null default 'text' check (kind in ('text', 'file', 'call', 'system')),
  body text,
  file_path text,
  file_name text,
  file_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_created_idx on public.messages (conversation_id, created_at desc);

-- Kiểm tra user hiện tại có trong hội thoại không (security definer để tránh vòng lặp RLS)
create or replace function public.is_member(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = auth.uid()
  );
$$;

-- Cập nhật thời điểm tin nhắn cuối để sắp xếp danh sách
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles
  for select to authenticated using (true);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "conversations member read" on public.conversations;
create policy "conversations member read" on public.conversations
  for select to authenticated using (public.is_member(id));
drop policy if exists "conversations member rename group" on public.conversations;
create policy "conversations member rename group" on public.conversations
  for update to authenticated using (public.is_member(id) and is_group) with check (public.is_member(id) and is_group);

drop policy if exists "members read" on public.conversation_members;
create policy "members read" on public.conversation_members
  for select to authenticated using (public.is_member(conversation_id));
drop policy if exists "members leave group" on public.conversation_members;
create policy "members leave group" on public.conversation_members
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "messages member read" on public.messages;
create policy "messages member read" on public.messages
  for select to authenticated using (public.is_member(conversation_id));
drop policy if exists "messages member send" on public.messages;
create policy "messages member send" on public.messages
  for insert to authenticated with check (sender_id = auth.uid() and public.is_member(conversation_id));

-- ---------- RPC ----------
-- Tạo chat 1-1 (trả về chat cũ nếu đã có) hoặc tạo nhóm
create or replace function public.create_conversation(p_member_ids uuid[], p_name text default null, p_is_group boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_other uuid;
begin
  if v_me is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if not p_is_group then
    if coalesce(array_length(p_member_ids, 1), 0) <> 1 or p_member_ids[1] = v_me then
      raise exception 'DIRECT_CHAT_NEEDS_ONE_OTHER_MEMBER';
    end if;
    v_other := p_member_ids[1];
    select c.id into v_id
    from public.conversations c
    join public.conversation_members a on a.conversation_id = c.id and a.user_id = v_me
    join public.conversation_members b on b.conversation_id = c.id and b.user_id = v_other
    where not c.is_group
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  insert into public.conversations (name, is_group, created_by)
  values (nullif(trim(p_name), ''), p_is_group, v_me)
  returning id into v_id;

  insert into public.conversation_members (conversation_id, user_id)
  select distinct v_id, u
  from unnest(array_append(p_member_ids, v_me)) as u
  where exists (select 1 from public.profiles p where p.id = u);

  return v_id;
end $$;

-- Thêm thành viên vào nhóm (người gọi phải đang ở trong nhóm)
create or replace function public.add_group_members(p_conversation_id uuid, p_member_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_conversation_id) then
    raise exception 'NOT_A_MEMBER';
  end if;
  if not exists (select 1 from public.conversations where id = p_conversation_id and is_group) then
    raise exception 'NOT_A_GROUP';
  end if;
  insert into public.conversation_members (conversation_id, user_id)
  select p_conversation_id, u
  from unnest(p_member_ids) as u
  where exists (select 1 from public.profiles p where p.id = u)
  on conflict do nothing;
end $$;

-- Đánh dấu đã đọc theo giờ server
create or replace function public.mark_read(p_conversation_id uuid)
returns timestamptz language sql security definer set search_path = public as $$
  update public.conversation_members
  set last_read_at = now()
  where conversation_id = p_conversation_id and user_id = auth.uid()
  returning last_read_at;
$$;

-- Danh sách hội thoại của tôi + tin cuối + số chưa đọc
create or replace function public.my_conversations()
returns table (
  id uuid,
  name text,
  is_group boolean,
  last_message_at timestamptz,
  my_last_read_at timestamptz,
  last_body text,
  last_kind text,
  last_sender_id uuid,
  last_file_name text,
  unread int,
  member_ids uuid[]
) language sql stable security invoker set search_path = public as $$
  select
    c.id, c.name, c.is_group, c.last_message_at, me.last_read_at,
    lm.body, lm.kind, lm.sender_id, lm.file_name,
    (select count(*)::int from public.messages m
      where m.conversation_id = c.id and m.created_at > me.last_read_at and m.sender_id <> auth.uid()),
    (select array_agg(cm.user_id) from public.conversation_members cm where cm.conversation_id = c.id)
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join lateral (
    select m.body, m.kind, m.sender_id, m.file_name
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  order by c.last_message_at desc;
$$;

grant execute on function public.create_conversation(uuid[], text, boolean) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.mark_read(uuid) to authenticated;
grant execute on function public.my_conversations() to authenticated;

-- ---------- Storage: file / ảnh gửi trong chat (tối đa 25MB) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400)
on conflict (id) do nothing;

drop policy if exists "chat files member read" on storage.objects;
create policy "chat files member read" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and public.is_member(((storage.foldername(name))[1])::uuid));

drop policy if exists "chat files member upload" on storage.objects;
create policy "chat files member upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-files' and public.is_member(((storage.foldername(name))[1])::uuid));

-- ---------- Realtime ----------
do $$
begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
end $$;

-- Muốn bật mã mời, chạy thêm (đổi ABC123 thành mã của bạn):
-- update public.app_settings set invite_code = 'ABC123' where id = 1;
