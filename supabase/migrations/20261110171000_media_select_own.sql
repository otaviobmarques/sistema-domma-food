-- Domma Food · 011 · Gestores podem listar/sobrescrever arquivos da PRÓPRIA pasta no bucket de mídias
-- (a listagem pública continua bloqueada; as URLs públicas das fotos seguem funcionando).
create policy media_select_own on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and private.can_manage(((storage.foldername(name))[1])::uuid));
