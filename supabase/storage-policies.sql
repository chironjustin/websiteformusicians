-- Storage bucket setup notes:
-- Create these buckets in the Supabase dashboard or via supported Supabase tooling:
--   artist-images: public
--   artwork: public
--   merch-images: public
--   audio: private
--
-- File paths are scoped as:
--   user-id/event-id/filename.ext
--
-- The policies below assume those buckets already exist.

create policy "Public can read artist images"
on storage.objects
for select
using (bucket_id = 'artist-images');

create policy "Public can read artwork"
on storage.objects
for select
using (bucket_id = 'artwork');

create policy "Public can read merch images"
on storage.objects
for select
using (bucket_id = 'merch-images');

create policy "Authenticated users can upload scoped files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id in ('artist-images', 'artwork', 'merch-images', 'audio')
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "Users can update their own scoped files"
on storage.objects
for update
to authenticated
using (
  bucket_id in ('artist-images', 'artwork', 'merch-images', 'audio')
  and auth.uid()::text = (storage.foldername(name))[1]
)
with check (
  bucket_id in ('artist-images', 'artwork', 'merch-images', 'audio')
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "Users can delete their own scoped files"
on storage.objects
for delete
to authenticated
using (
  bucket_id in ('artist-images', 'artwork', 'merch-images', 'audio')
  and auth.uid()::text = (storage.foldername(name))[1]
);

-- Do not add a public read policy for the audio bucket.
-- The app uses signed URLs for unreleased audio playback.
