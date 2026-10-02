-- SNS에서 가져온 레시피: 원본 링크 저장, source에 'sns' 추가
alter table public.recipes
  add column source_url text check (source_url is null or (source_url ~ '^https?://' and char_length(source_url) <= 500));
alter table public.recipes drop constraint recipes_source_check;
alter table public.recipes add constraint recipes_source_check check (source in ('mine', 'ai', 'sns'));
