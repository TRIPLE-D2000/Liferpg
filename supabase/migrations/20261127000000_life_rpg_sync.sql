-- Life RPG cloud sync: schema, row level security, and server functions.
-- Design rules:
--   * Every table is owned per user (user_id) and has RLS enabled.
--   * Browsers get SELECT only. ALL writes go through sync_push / reset_account, which use auth.uid()
--     (never a client-supplied user id), validate data, and run atomically.
--   * History (completions, ledger, ownership) is insert-only. Redemptions may only go redeemed -> refunded.
--   * Quest deletion is a tombstone (deleted_at); history is never removed except by reset_account.
--   * reset_generation lets the server reject stale devices after a reset.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create sequence public.sync_seq;

create table public.user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reset_generation integer not null default 1 check (reset_generation >= 1),
  created_at timestamptz not null default now(),
  last_reset_at timestamptz
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Player' check (char_length(display_name) between 1 and 40),
  difficulty_mode text not null default 'normal' check (difficulty_mode in ('normal','gentle','rest')),
  weekly_target_days smallint not null default 4 check (weekly_target_days between 1 and 7),
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  server_seq bigint not null default nextval('public.sync_seq')
);

create table public.quests (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  title text not null check (char_length(title) between 1 and 200),
  finish_condition text not null default '' check (char_length(finish_condition) <= 500),
  type text not null check (type in ('main','milestone','daily','weekly','side')),
  effort_tier text not null check (effort_tier in ('small','standard','meaningful','major')),
  attribute_id text not null check (attribute_id in ('craft','body','mind','order')),
  xp_reward integer not null check (xp_reward in (5,10,25,50)),
  status text not null check (status in ('active','paused','completed','archived')),
  is_gold_eligible boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision integer not null default 1,
  deleted_at timestamptz,
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, id)
);

create table public.completions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  quest_id text not null check (char_length(quest_id) between 1 and 64),
  period_key text not null check (char_length(period_key) between 1 and 20),
  quest_title_snapshot text not null check (char_length(quest_title_snapshot) between 1 and 200),
  attribute_id text not null check (attribute_id in ('craft','body','mind','order')),
  effort_tier text check (effort_tier in ('small','standard','meaningful','major')),
  xp_awarded integer not null check (xp_awarded >= 0),
  gold_awarded integer not null default 0 check (gold_awarded >= 0),
  completed_at timestamptz not null,
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, id),
  unique (user_id, quest_id, period_key)          -- one completion per quest per period, enforced on the server too
);

create table public.currency_ledger (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  amount integer not null check (amount <> 0 and abs(amount) <= 1000000),
  reason text not null check (char_length(reason) between 1 and 300),
  related_completion_id text,
  related_redemption_id text,
  related_cosmetic_id text,
  created_at timestamptz not null,
  transaction_key text not null check (char_length(transaction_key) between 1 and 200),
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, id),
  unique (user_id, transaction_key)               -- idempotency: the same transaction can never be credited/debited twice
);

create table public.rewards (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 1000),
  gold_cost integer not null check (gold_cost between 1 and 100000),
  is_active boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision integer not null default 1,
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, id)
);

create table public.redemptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  reward_id text not null check (char_length(reward_id) between 1 and 64),
  reward_title_snapshot text not null check (char_length(reward_title_snapshot) between 1 and 200),
  gold_spent integer not null check (gold_spent >= 1),
  status text not null check (status in ('redeemed','refunded')),
  redeemed_at timestamptz not null,
  refunded_at timestamptz,
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, id)
);

create table public.cosmetic_ownership (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null check (char_length(item_id) between 1 and 64),
  source text not null check (source in ('gold','achievement')),
  price_paid integer not null default 0 check (price_paid >= 0),
  acquired_at timestamptz not null,
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, item_id)                  -- ownership is unique: no duplicate purchases
);

create table public.equipped_cosmetics (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot text not null check (char_length(slot) between 1 and 32),
  item_id text check (char_length(item_id) between 1 and 64),   -- null = default appearance
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  server_seq bigint not null default nextval('public.sync_seq'),
  primary key (user_id, slot)
);

create table public.sync_ops (                    -- idempotency log: one row per processed operation
  user_id uuid not null references auth.users(id) on delete cascade,
  op_id text not null check (char_length(op_id) between 1 and 100),
  device_id text not null,
  generation integer not null,
  result jsonb not null,
  applied_at timestamptz not null default now(),
  primary key (user_id, op_id)
);

-- ---- triggers ---------------------------------------------------------------------------------
create function private.touch_seq() returns trigger language plpgsql set search_path = '' as $$
begin new.server_seq := nextval('public.sync_seq'); return new; end $$;

-- Blocks UPDATE/DELETE on history and tombstoned definitions, except inside reset_account.
create function private.block_mutation() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('lifrpg.resetting', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'Life RPG: % on % is not allowed', tg_op, tg_table_name using errcode = '42501';
end $$;

create function private.guard_redemption() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('lifrpg.resetting', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'redeemed' and new.status = 'refunded'
     and (new.user_id, new.id, new.reward_id, new.reward_title_snapshot, new.gold_spent, new.redeemed_at)
         is not distinct from (old.user_id, old.id, old.reward_id, old.reward_title_snapshot, old.gold_spent, old.redeemed_at) then
    return new;
  end if;
  raise exception 'Life RPG: redemptions may only change from redeemed to refunded' using errcode = '42501';
end $$;

create trigger completions_immutable before update or delete on public.completions for each row execute function private.block_mutation();
create trigger ledger_immutable before update or delete on public.currency_ledger for each row execute function private.block_mutation();
create trigger ownership_immutable before update or delete on public.cosmetic_ownership for each row execute function private.block_mutation();
create trigger quests_no_delete before delete on public.quests for each row execute function private.block_mutation();
create trigger rewards_no_delete before delete on public.rewards for each row execute function private.block_mutation();
create trigger redemptions_guard before update or delete on public.redemptions for each row execute function private.guard_redemption();

-- ---- indexes, RLS, privileges -----------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['user_settings','quests','completions','currency_ledger','rewards','redemptions','cosmetic_ownership','equipped_cosmetics'] loop
    execute format('create index %I on public.%I (user_id, server_seq)', t || '_user_seq_idx', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.touch_seq()', t || '_touch', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  alter table public.user_state enable row level security;
  create policy user_state_select_own on public.user_state for select to authenticated using (user_id = (select auth.uid()));
  revoke all on public.user_state from anon, authenticated;
  grant select on public.user_state to authenticated;
  alter table public.sync_ops enable row level security;      -- no policies, no grants: server-internal only
  revoke all on public.sync_ops from anon, authenticated;
end $$;

-- ---- helpers ----------------------------------------------------------------------------------
create function private.ensure_state(p_uid uuid) returns integer language plpgsql set search_path = '' as $$
declare gen integer;
begin
  insert into public.user_state (user_id) values (p_uid) on conflict do nothing;
  insert into public.user_settings (user_id) values (p_uid) on conflict do nothing;
  select reset_generation into gen from public.user_state where user_id = p_uid;
  return gen;
end $$;

-- Applies ONE operation. Returns a status object; table CHECK constraints do the validation
-- (a violation is caught by the caller and reported as 'invalid' without aborting the batch).
create function private.apply_op(uid uuid, typ text, p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare
  cur_rev integer; tomb timestamptz; srv jsonb; found_id text; bal bigint; v_amount integer; st text;
begin
  case typ
  when 'completion.add' then
    if exists (select 1 from public.completions where user_id = uid and id = p->>'id') then return jsonb_build_object('status','duplicate'); end if;
    select id into found_id from public.completions where user_id = uid and quest_id = p->>'quest_id' and period_key = p->>'period_key';
    if found then return jsonb_build_object('status','rejected_duplicate_period','existing_id',found_id); end if;
    insert into public.completions (user_id,id,quest_id,period_key,quest_title_snapshot,attribute_id,effort_tier,xp_awarded,gold_awarded,completed_at)
    values (uid, p->>'id', p->>'quest_id', p->>'period_key', p->>'quest_title_snapshot', p->>'attribute_id', nullif(p->>'effort_tier',''),
            (p->>'xp_awarded')::integer, coalesce((p->>'gold_awarded')::integer, 0), (p->>'completed_at')::timestamptz);
    return jsonb_build_object('status','applied');

  when 'ledger.add' then
    if exists (select 1 from public.currency_ledger where user_id = uid and id = p->>'id') then return jsonb_build_object('status','duplicate'); end if;
    if exists (select 1 from public.currency_ledger where user_id = uid and transaction_key = p->>'transaction_key') then return jsonb_build_object('status','rejected_duplicate_key'); end if;
    if p->>'related_completion_id' is not null and not exists (select 1 from public.completions where user_id = uid and id = p->>'related_completion_id') then
      return jsonb_build_object('status','rejected_missing_reference'); end if;
    if p->>'related_redemption_id' is not null and not exists (select 1 from public.redemptions where user_id = uid and id = p->>'related_redemption_id') then
      return jsonb_build_object('status','rejected_missing_reference'); end if;
    v_amount := (p->>'amount')::integer;
    if v_amount < 0 then                                   -- the server re-checks the balance: it can never go negative
      select coalesce(sum(amount), 0) into bal from public.currency_ledger where user_id = uid;
      if bal + v_amount < 0 then return jsonb_build_object('status','rejected_insufficient','balance',bal); end if;
    end if;
    insert into public.currency_ledger (user_id,id,amount,reason,related_completion_id,related_redemption_id,related_cosmetic_id,created_at,transaction_key)
    values (uid, p->>'id', v_amount, p->>'reason', p->>'related_completion_id', p->>'related_redemption_id', p->>'related_cosmetic_id',
            (p->>'created_at')::timestamptz, p->>'transaction_key');
    return jsonb_build_object('status','applied');

  when 'quest.upsert' then
    select revision, deleted_at into cur_rev, tomb from public.quests where user_id = uid and id = p->>'id';
    if not found then
      insert into public.quests (user_id,id,title,finish_condition,type,effort_tier,attribute_id,xp_reward,status,is_gold_eligible,created_at,updated_at)
      values (uid, p->>'id', p->>'title', coalesce(p->>'finish_condition',''), p->>'type', p->>'effort_tier', p->>'attribute_id',
              (p->>'xp_reward')::integer, p->>'status', coalesce((p->>'is_gold_eligible')::boolean, true), (p->>'created_at')::timestamptz, (p->>'updated_at')::timestamptz);
      return jsonb_build_object('status','applied','revision',1);
    end if;
    if tomb is not null then return jsonb_build_object('status','rejected_deleted'); end if;
    if (p->>'base_revision')::integer is distinct from cur_rev then
      select to_jsonb(q) - 'user_id' into srv from public.quests q where user_id = uid and id = p->>'id';
      return jsonb_build_object('status','conflict','server',srv);
    end if;
    update public.quests set title = p->>'title', finish_condition = coalesce(p->>'finish_condition',''), type = p->>'type',
      effort_tier = p->>'effort_tier', attribute_id = p->>'attribute_id', xp_reward = (p->>'xp_reward')::integer, status = p->>'status',
      is_gold_eligible = coalesce((p->>'is_gold_eligible')::boolean, true), updated_at = (p->>'updated_at')::timestamptz, revision = cur_rev + 1
    where user_id = uid and id = p->>'id';
    return jsonb_build_object('status','applied','revision',cur_rev + 1);

  when 'quest.delete' then                                  -- tombstone: the row (and all history) stays
    select deleted_at into tomb from public.quests where user_id = uid and id = p->>'id';
    if not found then
      insert into public.quests (user_id,id,title,finish_condition,type,effort_tier,attribute_id,xp_reward,status,is_gold_eligible,created_at,updated_at,deleted_at)
      values (uid, p->>'id', p->>'title', coalesce(p->>'finish_condition',''), p->>'type', p->>'effort_tier', p->>'attribute_id',
              (p->>'xp_reward')::integer, p->>'status', coalesce((p->>'is_gold_eligible')::boolean, true), (p->>'created_at')::timestamptz, (p->>'updated_at')::timestamptz, now());
      return jsonb_build_object('status','applied');
    end if;
    if tomb is not null then return jsonb_build_object('status','duplicate'); end if;
    update public.quests set deleted_at = now(), revision = revision + 1 where user_id = uid and id = p->>'id';
    return jsonb_build_object('status','applied');

  when 'reward.upsert' then
    select revision into cur_rev from public.rewards where user_id = uid and id = p->>'id';
    if not found then
      insert into public.rewards (user_id,id,title,description,gold_cost,is_active,created_at,updated_at)
      values (uid, p->>'id', p->>'title', coalesce(p->>'description',''), (p->>'gold_cost')::integer, coalesce((p->>'is_active')::boolean, true),
              (p->>'created_at')::timestamptz, (p->>'updated_at')::timestamptz);
      return jsonb_build_object('status','applied','revision',1);
    end if;
    if (p->>'base_revision')::integer is distinct from cur_rev then
      select to_jsonb(r) - 'user_id' into srv from public.rewards r where user_id = uid and id = p->>'id';
      return jsonb_build_object('status','conflict','server',srv);
    end if;
    update public.rewards set title = p->>'title', description = coalesce(p->>'description',''), gold_cost = (p->>'gold_cost')::integer,
      is_active = coalesce((p->>'is_active')::boolean, true), updated_at = (p->>'updated_at')::timestamptz, revision = cur_rev + 1
    where user_id = uid and id = p->>'id';
    return jsonb_build_object('status','applied','revision',cur_rev + 1);

  when 'redemption.add' then
    if exists (select 1 from public.redemptions where user_id = uid and id = p->>'id') then return jsonb_build_object('status','duplicate'); end if;
    if not exists (select 1 from public.rewards where user_id = uid and id = p->>'reward_id') then return jsonb_build_object('status','rejected_missing_reference'); end if;
    insert into public.redemptions (user_id,id,reward_id,reward_title_snapshot,gold_spent,status,redeemed_at)
    values (uid, p->>'id', p->>'reward_id', p->>'reward_title_snapshot', (p->>'gold_spent')::integer, 'redeemed', (p->>'redeemed_at')::timestamptz);
    return jsonb_build_object('status','applied');

  when 'redemption.refund' then
    select status into st from public.redemptions where user_id = uid and id = p->>'id';
    if not found then return jsonb_build_object('status','rejected_missing_reference'); end if;
    if st = 'refunded' then return jsonb_build_object('status','duplicate'); end if;
    update public.redemptions set status = 'refunded', refunded_at = (p->>'refunded_at')::timestamptz where user_id = uid and id = p->>'id';
    return jsonb_build_object('status','applied');

  when 'cosmetic.own' then
    if exists (select 1 from public.cosmetic_ownership where user_id = uid and item_id = p->>'item_id') then return jsonb_build_object('status','duplicate'); end if;
    insert into public.cosmetic_ownership (user_id,item_id,source,price_paid,acquired_at)
    values (uid, p->>'item_id', p->>'source', coalesce((p->>'price_paid')::integer, 0), (p->>'acquired_at')::timestamptz);
    return jsonb_build_object('status','applied');

  when 'cosmetic.equip' then
    if p->>'item_id' is not null and not exists (select 1 from public.cosmetic_ownership where user_id = uid and item_id = p->>'item_id') then
      return jsonb_build_object('status','rejected_missing_reference'); end if;     -- you can only equip what you own
    select revision into cur_rev from public.equipped_cosmetics where user_id = uid and slot = p->>'slot';
    if not found then
      insert into public.equipped_cosmetics (user_id,slot,item_id) values (uid, p->>'slot', p->>'item_id');
      return jsonb_build_object('status','applied','revision',1);
    end if;
    if (p->>'base_revision')::integer is distinct from cur_rev then
      select to_jsonb(e) - 'user_id' into srv from public.equipped_cosmetics e where user_id = uid and slot = p->>'slot';
      return jsonb_build_object('status','conflict','server',srv);
    end if;
    update public.equipped_cosmetics set item_id = p->>'item_id', revision = cur_rev + 1, updated_at = now() where user_id = uid and slot = p->>'slot';
    return jsonb_build_object('status','applied','revision',cur_rev + 1);

  when 'settings.update' then
    select revision into cur_rev from public.user_settings where user_id = uid;
    if (p->>'base_revision')::integer is distinct from cur_rev then
      select to_jsonb(s) - 'user_id' into srv from public.user_settings s where user_id = uid;
      return jsonb_build_object('status','conflict','server',srv);
    end if;
    update public.user_settings set display_name = coalesce(p->>'display_name', display_name),
      difficulty_mode = coalesce(p->>'difficulty_mode', difficulty_mode),
      weekly_target_days = coalesce((p->>'weekly_target_days')::smallint, weekly_target_days),
      revision = cur_rev + 1, updated_at = now()
    where user_id = uid;
    return jsonb_build_object('status','applied','revision',cur_rev + 1);

  else
    return jsonb_build_object('status','invalid','message','unknown operation type');
  end case;
end $$;

-- ---- public API -------------------------------------------------------------------------------
create function public.sync_push(p_device_id text, p_generation integer, p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  cur integer; op jsonb; opid text; typ text; p jsonb; res jsonb; prior jsonb; results jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then raise exception 'ops must be an array' using errcode = '22023'; end if;
  if jsonb_array_length(p_ops) > 200 then raise exception 'too many operations (max 200 per push)' using errcode = '22023'; end if;
  if p_device_id is null or char_length(p_device_id) not between 1 and 64 then raise exception 'invalid device id' using errcode = '22023'; end if;
  perform private.ensure_state(uid);
  -- Row lock: pushes and resets for one user are serialized, so a push can never race a reset.
  select reset_generation into cur from public.user_state where user_id = uid for update;
  if p_generation is distinct from cur then
    return jsonb_build_object('status','stale_generation','generation',cur);
  end if;
  for op in select value from jsonb_array_elements(p_ops) loop
    opid := op->>'op_id'; typ := op->>'type'; p := op->'payload';
    if opid is null or char_length(opid) not between 1 and 100 or typ is null or p is null or jsonb_typeof(p) <> 'object' then
      results := results || jsonb_build_object('op_id', opid, 'status','invalid','message','malformed operation');
      continue;
    end if;
    select result into prior from public.sync_ops where user_id = uid and op_id = opid;
    if found then results := results || (prior || jsonb_build_object('replayed', true)); continue; end if;
    begin
      res := private.apply_op(uid, typ, p);
    exception when others then
      res := jsonb_build_object('status','invalid','message', sqlerrm);
    end;
    res := res || jsonb_build_object('op_id', opid);
    insert into public.sync_ops (user_id, op_id, device_id, generation, result) values (uid, opid, p_device_id, cur, res);
    results := results || res;
  end loop;
  return jsonb_build_object('status','ok','generation',cur,'results',results);
end $$;

create function public.sync_pull(p_generation integer, p_since bigint default 0, p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cur integer; changes jsonb; maxseq bigint; total integer;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  p_limit := least(greatest(coalesce(p_limit, 500), 1), 1000);
  p_since := coalesce(p_since, 0);
  cur := private.ensure_state(uid);
  if p_generation is distinct from cur then
    return jsonb_build_object('status','stale_generation','generation',cur);
  end if;
  with c as (
    select 'settings' as tbl, server_seq, to_jsonb(x) - 'user_id' as r from public.user_settings x where user_id = uid and server_seq > p_since
    union all select 'quests', server_seq, to_jsonb(x) - 'user_id' from public.quests x where user_id = uid and server_seq > p_since
    union all select 'completions', server_seq, to_jsonb(x) - 'user_id' from public.completions x where user_id = uid and server_seq > p_since
    union all select 'ledger', server_seq, to_jsonb(x) - 'user_id' from public.currency_ledger x where user_id = uid and server_seq > p_since
    union all select 'rewards', server_seq, to_jsonb(x) - 'user_id' from public.rewards x where user_id = uid and server_seq > p_since
    union all select 'redemptions', server_seq, to_jsonb(x) - 'user_id' from public.redemptions x where user_id = uid and server_seq > p_since
    union all select 'ownership', server_seq, to_jsonb(x) - 'user_id' from public.cosmetic_ownership x where user_id = uid and server_seq > p_since
    union all select 'equipped', server_seq, to_jsonb(x) - 'user_id' from public.equipped_cosmetics x where user_id = uid and server_seq > p_since
  ), page as (select * from c order by server_seq limit p_limit)
  select coalesce(jsonb_agg(jsonb_build_object('table', tbl, 'seq', server_seq, 'row', r) order by server_seq), '[]'::jsonb),
         coalesce(max(server_seq), p_since), (select count(*) from c)
    into changes, maxseq, total
  from page;
  return jsonb_build_object('status','ok','generation',cur,'changes',changes,'cursor',maxseq,'has_more', total > p_limit);
end $$;

-- Erases this user's Life RPG data (never the login) and bumps the reset generation, atomically.
-- Takes NO user id: it can only ever act on the caller's own account.
create function public.reset_account(p_expected_generation integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cur integer;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  perform private.ensure_state(uid);
  select reset_generation into cur from public.user_state where user_id = uid for update;
  if p_expected_generation is not null and p_expected_generation <> cur then
    return jsonb_build_object('status','stale_generation','generation',cur);
  end if;
  perform set_config('lifrpg.resetting', 'on', true);
  delete from public.sync_ops where user_id = uid;
  delete from public.equipped_cosmetics where user_id = uid;
  delete from public.cosmetic_ownership where user_id = uid;
  delete from public.redemptions where user_id = uid;
  delete from public.rewards where user_id = uid;
  delete from public.currency_ledger where user_id = uid;
  delete from public.completions where user_id = uid;
  delete from public.quests where user_id = uid;
  delete from public.user_settings where user_id = uid;
  perform set_config('lifrpg.resetting', 'off', true);
  insert into public.user_settings (user_id) values (uid);
  update public.user_state set reset_generation = cur + 1, last_reset_at = now() where user_id = uid;
  return jsonb_build_object('status','ok','generation',cur + 1);
end $$;

revoke all on function public.sync_push(text, integer, jsonb) from public, anon;
revoke all on function public.sync_pull(integer, bigint, integer) from public, anon;
revoke all on function public.reset_account(integer) from public, anon;
grant execute on function public.sync_push(text, integer, jsonb) to authenticated;
grant execute on function public.sync_pull(integer, bigint, integer) to authenticated;
grant execute on function public.reset_account(integer) to authenticated;
