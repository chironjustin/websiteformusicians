-- Server-generated one-click live chat identities.
-- Safe to rerun after supabase/chat-participants-migration.sql.

alter table public.event_chat_participants
add column if not exists session_id uuid;

alter table public.event_chat_participants
add column if not exists last_seen_at timestamptz not null default now();

create unique index if not exists event_chat_participants_event_session_idx
on public.event_chat_participants(event_id, session_id)
where session_id is not null;

revoke select, insert, update, delete on public.event_chat_participants from anon, authenticated;

drop policy if exists "Public can read live event chat participants" on public.event_chat_participants;

revoke all on function public.reserve_event_chat_identity(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.reserve_event_chat_identity(uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function public.chat_generated_first_names()
returns text[]
language sql
stable
set search_path = public
as $$
  with
    core(name) as (
      values
        ('Aiko'), ('Mateo'), ('Soren'), ('Amira'), ('Luca'), ('Yara'), ('Kai'), ('Noel'), ('Eva'), ('Nina'), ('Theo'), ('Mila'), ('Omar'), ('Ines'), ('Leo'),
        ('Aarav'), ('Aaliyah'), ('Abasi'), ('Abena'), ('Adama'), ('Adel'), ('Aditi'), ('Afi'), ('Aisha'), ('Akari'), ('Akira'), ('Alba'), ('Alejandro'),
        ('Alessia'), ('Alex'), ('Ali'), ('Alma'), ('Amal'), ('Amani'), ('Amara'), ('Ana'), ('Anahi'), ('Ananya'), ('Anders'), ('Anika'), ('Anisa'),
        ('Anja'), ('Anwar'), ('Aoife'), ('Aria'), ('Ariel'), ('Arjun'), ('Arlo'), ('Asha'), ('Astrid'), ('Aya'), ('Ayana'), ('Ayaan'), ('Ayodele'),
        ('Aziz'), ('Bao'), ('Bea'), ('Beatriz'), ('Belen'), ('Ben'), ('Binta'), ('Bjorn'), ('Bodhi'), ('Bruno'), ('Cai'), ('Camila'), ('Carlos'),
        ('Carmen'), ('Celeste'), ('Chandra'), ('Chiara'), ('Chidi'), ('Chika'), ('Chloe'), ('Cian'), ('Clara'), ('Cleo'), ('Cora'), ('Dalia'),
        ('Damian'), ('Danilo'), ('Dara'), ('Daria'), ('Davi'), ('Dawit'), ('Deepa'), ('Diego'), ('Dina'), ('Diya'), ('Eden'), ('Eka'), ('Elena'),
        ('Eli'), ('Elian'), ('Elif'), ('Elio'), ('Elise'), ('Emil'), ('Emilia'), ('Emir'), ('Enzo'), ('Eri'), ('Esme'), ('Esther'), ('Evan'),
        ('Ewan'), ('Farah'), ('Farid'), ('Fatima'), ('Felix'), ('Finn'), ('Fiona'), ('Freya'), ('Gael'), ('Gita'), ('Giorgio'), ('Grace'),
        ('Hana'), ('Hani'), ('Hanna'), ('Harper'), ('Hassan'), ('Hector'), ('Helena'), ('Hiro'), ('Ibrahim'), ('Idris'), ('Iker'), ('Ilana'),
        ('Imani'), ('Imran'), ('Ina'), ('Iris'), ('Isa'), ('Isabel'), ('Isla'), ('Ivan'), ('Ivy'), ('Jada'), ('Jae'), ('Jalen'), ('Jamila'),
        ('Jasper'), ('Jaya'), ('Jean'), ('Jia'), ('Jin'), ('Joao'), ('Jonas'), ('Jules'), ('Jun'), ('Kaito'), ('Kala'), ('Kamau'), ('Kamil'),
        ('Kara'), ('Karim'), ('Kaya'), ('Keiko'), ('Kenji'), ('Khalil'), ('Kiara'), ('Kira'), ('Kofi'), ('Ksenia'), ('Laila'), ('Lana'),
        ('Lars'), ('Lea'), ('Leila'), ('Leon'), ('Leona'), ('Lian'), ('Lina'), ('Lior'), ('Livia'), ('Lucia'), ('Luis'), ('Luka'), ('Luna'),
        ('Mabel'), ('Mae'), ('Maha'), ('Maia'), ('Malik'), ('Malika'), ('Manu'), ('Mara'), ('Marco'), ('Maria'), ('Mariam'), ('Marina'),
        ('Maya'), ('Mei'), ('Mika'), ('Milan'), ('Mina'), ('Mira'), ('Miro'), ('Musa'), ('Nadia'), ('Nala'), ('Naomi'), ('Nari'), ('Nasir'),
        ('Nia'), ('Nico'), ('Nika'), ('Nikhil'), ('Noa'), ('Nolan'), ('Nora'), ('Noura'), ('Ola'), ('Oona'), ('Orla'), ('Oscar'), ('Pablo'),
        ('Paloma'), ('Paolo'), ('Pari'), ('Priya'), ('Rafael'), ('Rafi'), ('Rania'), ('Ravi'), ('Remy'), ('Rina'), ('Rio'), ('Rohan'),
        ('Rosa'), ('Saanvi'), ('Sacha'), ('Sadia'), ('Sam'), ('Sami'), ('Samira'), ('Sana'), ('Santiago'), ('Sara'), ('Sasha'), ('Selam'),
        ('Selena'), ('Seo'), ('Seren'), ('Sofia'), ('Talia'), ('Tariq'), ('Tara'), ('Teo'), ('Thandi'), ('Tia'), ('Tobias'), ('Toma'),
        ('Tomas'), ('Uma'), ('Uri'), ('Valeria'), ('Vera'), ('Viktor'), ('Vina'), ('Viola'), ('Wale'), ('Xavi'), ('Ximena'), ('Yasmin'),
        ('Yuki'), ('Yuna'), ('Yusuf'), ('Zain'), ('Zara'), ('Zia'), ('Zoe')
    ),
    prefix(value) as (
      select unnest(array['Ada','Ala','Ama','Ana','Ari','Asha','Avi','Aya','Bela','Cai','Cara','Dalia','Dara','Eli','Emi','Eni','Fara','Gio','Hana','Ida','Ila','Ina','Ira','Jae','Jana','Kaya','Kira','Lana','Lea','Lia','Lina','Mara','Mika','Mina','Mira','Nala','Nari','Nia','Nika','Noa','Nora','Ola','Pari','Rafi','Rina','Sami','Sana','Tala','Tari','Uma','Vera','Yara','Zara','Zia'])
    ),
    suffix(value) as (
      select unnest(array['an','ar','el','en','ia','il','in','io','is','ko','la','li','lo','ma','mi','na','ni','no','ra','ri','ro','sa','ta','ti','ya','yo','ara','ari','ela','emi','ena','ika','ina','ira','iya','lan','leo','lia','lin','mar','min','mir','mon','nal','ran','ren','ria','rin','rio','sam','sen','sha','tal','tan','van','yan','zar','zra','dil','fem','har','jun','kai','len','mai','nel','ori','paz','raj','sol','teo','uri','val','wen','xan','yun','zen','ab','ad','af','ag','ah','aj','ak','al','am','as','av','az'])
    ),
    generated(name) as (
      select initcap(prefix.value || middle.value || ending.value)
      from prefix
      cross join suffix middle
      cross join suffix ending
      where char_length(prefix.value || middle.value || ending.value) between 3 and 13
      limit 6500
    )
  select array_agg(name order by name)
  from (
    select name from core
    union
    select name from generated
  ) names
  where public.normalize_chat_name(name) not in ('admin', 'artist', 'moderator', 'system', 'support');
$$;

create or replace function public.join_event_chat(
  p_event_id uuid,
  p_session_id uuid
)
returns public.event_chat_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  event_artist_name text;
  existing_participant public.event_chat_participants;
  inserted_participant public.event_chat_participants;
  names text[];
  base_name text;
  candidate_name text;
  normalized_candidate text;
  suffix text;
  avatar text;
  attempt integer;
begin
  if p_event_id is null then
    raise exception 'chat_event_required';
  end if;

  if p_session_id is null then
    raise exception 'chat_session_required';
  end if;

  select events.artist_name
  into event_artist_name
  from public.events
  where events.id = p_event_id
    and events.status in ('upcoming', 'live')
    and events.starts_at is not null
    and events.ends_at is not null
    and events.starts_at <= now()
    and events.ends_at > now();

  if event_artist_name is null then
    raise exception 'chat_event_not_live';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || p_session_id::text));

  select *
  into existing_participant
  from public.event_chat_participants
  where event_id = p_event_id
    and session_id = p_session_id
  limit 1;

  if existing_participant.id is not null then
    update public.event_chat_participants
    set last_seen_at = now()
    where id = existing_participant.id
    returning * into existing_participant;

    return existing_participant;
  end if;

  names := public.chat_generated_first_names();
  base_name := names[1 + floor(random() * array_length(names, 1))::int];
  avatar := 'retro-' || (1 + floor(random() * 8)::int)::text;

  for attempt in 0..8 loop
    if attempt = 0 then
      candidate_name := left(base_name, 16);
    else
      suffix := (10 + floor(random() * 990)::int)::text;
      candidate_name := left(base_name, greatest(1, 16 - char_length(suffix))) || suffix;
    end if;

    normalized_candidate := public.normalize_chat_name(candidate_name);

    if normalized_candidate in ('admin', 'artist', 'moderator', 'system', 'support') then
      continue;
    end if;

    if normalized_candidate = public.normalize_chat_name(event_artist_name) then
      continue;
    end if;

    begin
      insert into public.event_chat_participants (
        event_id,
        session_id,
        display_name,
        normalized_name,
        avatar_id,
        last_seen_at
      )
      values (
        p_event_id,
        p_session_id,
        candidate_name,
        normalized_candidate,
        avatar,
        now()
      )
      returning * into inserted_participant;

      return inserted_participant;
    exception
      when unique_violation then
        select *
        into existing_participant
        from public.event_chat_participants
        where event_id = p_event_id
          and session_id = p_session_id
        limit 1;

        if existing_participant.id is not null then
          return existing_participant;
        end if;
    end;
  end loop;

  candidate_name := 'Aiko' || (1000 + floor(random() * 9000)::int)::text;
  normalized_candidate := public.normalize_chat_name(candidate_name);

  insert into public.event_chat_participants (
    event_id,
    session_id,
    display_name,
    normalized_name,
    avatar_id,
    last_seen_at
  )
  values (
    p_event_id,
    p_session_id,
    candidate_name,
    normalized_candidate,
    avatar,
    now()
  )
  returning * into inserted_participant;

  return inserted_participant;
end;
$$;

revoke all on function public.join_event_chat(uuid, uuid) from public;
grant execute on function public.join_event_chat(uuid, uuid) to anon, authenticated;

drop function if exists public.submit_chat_message(uuid, uuid, text, text, text, uuid);

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
  p_body text,
  p_client_token uuid
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_body text;
  participant public.event_chat_participants;
  inserted_message public.chat_messages;
begin
  normalized_body := btrim(regexp_replace(coalesce(p_body, ''), '[[:space:]]+', ' ', 'g'));

  if p_event_id is null then
    raise exception 'A current live event is required.';
  end if;

  if p_participant_id is null then
    raise exception 'A reserved chat identity is required.';
  end if;

  if p_client_token is null then
    raise exception 'A client token is required.';
  end if;

  if normalized_body = '' or char_length(normalized_body) > 500 then
    raise exception 'Message must be between 1 and 500 characters.';
  end if;

  if not exists (
    select 1
    from public.events
    where events.id = p_event_id
      and events.status in ('upcoming', 'live')
      and events.starts_at is not null
      and events.ends_at is not null
      and events.starts_at <= now()
      and events.ends_at > now()
  ) then
    raise exception 'Chat is open only during a live event.';
  end if;

  select *
  into participant
  from public.event_chat_participants
  where id = p_participant_id
    and event_id = p_event_id;

  if participant.id is null then
    raise exception 'A reserved chat identity is required.';
  end if;

  insert into public.chat_messages (
    event_id,
    participant_id,
    user_id,
    display_name,
    avatar_id,
    body,
    status,
    client_token,
    is_admin,
    is_pinned,
    is_highlighted,
    is_liked,
    legacy_assignment_confirmed_at,
    legacy_assignment_confirmed_by
  )
  values (
    p_event_id,
    participant.id,
    null,
    participant.display_name,
    participant.avatar_id,
    normalized_body,
    'pending',
    p_client_token,
    false,
    false,
    false,
    false,
    null,
    null
  )
  returning * into inserted_message;

  return inserted_message;
end;
$$;

revoke all on function public.submit_chat_message(uuid, uuid, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
