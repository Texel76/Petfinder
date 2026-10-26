-- =====================================================================
-- PetFinder - Esquema de Supabase
-- Ejecutar completo en: Supabase > SQL Editor > New query > Run
--
-- Si ya habías creado la tabla "perfiles" (con columna "correo") y no tiene
-- datos importantes, descomenta la siguiente línea para recrearla:
-- drop table if exists public.perfiles cascade;
-- =====================================================================

-- 1) PERFILES (uno por usuario de auth.users) --------------------------
create table if not exists public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);
create unique index if not exists perfiles_username_unico
  on public.perfiles (lower(username));

-- 2) PUBLICACIONES -----------------------------------------------------
create table if not exists public.publicaciones (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.perfiles(id) on delete cascade,
  tipo text not null check (tipo in ('lost', 'sighted')),
  especie text not null default 'other' check (especie in ('dog', 'cat', 'other')),
  titulo text not null check (char_length(titulo) between 1 and 120),
  descripcion text not null check (char_length(descripcion) between 1 and 1000),
  ubicacion_texto text,
  lat double precision,
  lng double precision,
  imagen_url text,
  created_at timestamptz not null default now()
);
create index if not exists publicaciones_created_idx on public.publicaciones (created_at desc);

-- 3) COMENTARIOS (pistas) ----------------------------------------------
create table if not exists public.comentarios (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.publicaciones(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.perfiles(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comentarios_post_idx on public.comentarios (post_id);

-- 4) LIKES ---------------------------------------------------------------
create table if not exists public.likes (
  post_id bigint not null references public.publicaciones(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.perfiles(id) on delete cascade,
  primary key (post_id, user_id)
);

-- 5) TRIGGER: crear el perfil automáticamente al registrarse ------------
--    (así registro.html no necesita insertar en "perfiles", y funciona
--     aunque la confirmación por correo esté activada)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, username)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 6) FUNCIÓN: obtener el correo a partir del username (login por usuario)
create or replace function public.correo_por_username(p_username text)
returns text
language sql
security definer
set search_path = public, auth
as $$
  select u.email::text
  from auth.users u
  join public.perfiles p on p.id = u.id
  where lower(p.username) = lower(p_username)
  limit 1;
$$;
revoke all on function public.correo_por_username(text) from public;
grant execute on function public.correo_por_username(text) to anon, authenticated;

-- 7) ROW LEVEL SECURITY ---------------------------------------------------
alter table public.perfiles       enable row level security;
alter table public.publicaciones  enable row level security;
alter table public.comentarios    enable row level security;
alter table public.likes          enable row level security;

-- perfiles
drop policy if exists "perfiles_select" on public.perfiles;
create policy "perfiles_select" on public.perfiles
  for select to authenticated using (true);
drop policy if exists "perfiles_update_propio" on public.perfiles;
create policy "perfiles_update_propio" on public.perfiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- publicaciones
drop policy if exists "pub_select" on public.publicaciones;
create policy "pub_select" on public.publicaciones
  for select to authenticated using (true);
drop policy if exists "pub_insert" on public.publicaciones;
create policy "pub_insert" on public.publicaciones
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "pub_update" on public.publicaciones;
create policy "pub_update" on public.publicaciones
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "pub_delete" on public.publicaciones;
create policy "pub_delete" on public.publicaciones
  for delete to authenticated using (auth.uid() = user_id);

-- comentarios
drop policy if exists "com_select" on public.comentarios;
create policy "com_select" on public.comentarios
  for select to authenticated using (true);
drop policy if exists "com_insert" on public.comentarios;
create policy "com_insert" on public.comentarios
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "com_delete" on public.comentarios;
create policy "com_delete" on public.comentarios
  for delete to authenticated using (auth.uid() = user_id);

-- likes
drop policy if exists "likes_select" on public.likes;
create policy "likes_select" on public.likes
  for select to authenticated using (true);
drop policy if exists "likes_insert" on public.likes;
create policy "likes_insert" on public.likes
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "likes_delete" on public.likes;
create policy "likes_delete" on public.likes
  for delete to authenticated using (auth.uid() = user_id);

-- 8) STORAGE: bucket público "publicaciones" para las fotos --------------------
--    Las imágenes se guardan como  <user_id>/<archivo>  y solo el dueño
--    puede subir o borrar dentro de su carpeta.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('publicaciones', 'publicaciones', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "publicaciones_ver" on storage.objects;
create policy "publicaciones_ver" on storage.objects
  for select using (bucket_id = 'publicaciones');

drop policy if exists "publicaciones_subir" on storage.objects;
create policy "publicaciones_subir" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'publicaciones' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "publicaciones_borrar" on storage.objects;
create policy "publicaciones_borrar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'publicaciones' and (storage.foldername(name))[1] = auth.uid()::text);
