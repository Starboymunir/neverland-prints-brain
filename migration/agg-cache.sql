-- Precomputed filter/artist counts. get_filter_counts()/get_artist_counts() read a
-- single cached row (instant) instead of aggregating 186k rows on every call.
-- Refresh with: select public.refresh_agg_cache();
create table if not exists public.agg_cache (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.agg_cache enable row level security;

create or replace function public.refresh_agg_cache()
returns void language sql volatile as $$
  insert into public.agg_cache(key, value, updated_at)
  select 'filters', (
    with r as (select style, mood, ratio_class, era, subject, ai_tags from public.assets where ingestion_status in ('ready','analyzed'))
    select jsonb_build_object(
      'styles',(select coalesce(jsonb_agg(jsonb_build_object('value',style,'count',c) order by c desc),'[]') from (select style,count(*) c from r where style is not null group by style) q),
      'moods',(select coalesce(jsonb_agg(jsonb_build_object('value',mood,'count',c) order by c desc),'[]') from (select mood,count(*) c from r where mood is not null group by mood) q),
      'orientations',(select coalesce(jsonb_agg(jsonb_build_object('value',ratio_class,'count',c) order by c desc),'[]') from (select ratio_class,count(*) c from r where ratio_class is not null group by ratio_class) q),
      'eras',(select coalesce(jsonb_agg(jsonb_build_object('value',era,'count',c) order by c desc),'[]') from (select era,count(*) c from r where era is not null group by era) q),
      'subjects',(select coalesce(jsonb_agg(jsonb_build_object('value',subject,'count',c) order by c desc),'[]') from (select subject,count(*) c from r where subject is not null group by subject) q),
      'tags',(select coalesce(jsonb_agg(jsonb_build_object('value',tag,'count',c) order by c desc),'[]') from (select t as tag,count(*) c from r, jsonb_array_elements_text(r.ai_tags) t where jsonb_typeof(r.ai_tags)='array' group by t) q)
    )), now()
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  insert into public.agg_cache(key, value, updated_at)
  select 'artists', coalesce(jsonb_agg(jsonb_build_object('artist',artist,'count',c) order by c desc),'[]'), now()
  from (select artist, count(*) c from public.assets where ingestion_status in ('ready','analyzed') and artist is not null group by artist) q
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
$$;

create or replace function public.get_filter_counts()
returns jsonb language sql stable as $$
  select value from public.agg_cache where key = 'filters';
$$;

create or replace function public.get_artist_counts()
returns table(artist text, count bigint) language sql stable as $$
  select e->>'artist', (e->>'count')::bigint
  from public.agg_cache, jsonb_array_elements(value) e
  where key = 'artists';
$$;
