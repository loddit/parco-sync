# parco-sync

Cloudflare Worker that syncs objects from Supabase Storage into R2. It does not return file content; a successful sync is indicated by an empty `200` response.

Request flow:

1. Read the request path as the object key, for example `/avatars/a.png` -> `avatars/a.png`.
2. Fetch the same key from Supabase Storage, even if R2 already has a copy.
3. Write the object to R2 synchronously, overwriting any existing object.
4. Return `200` with an empty body only after the R2 write succeeds.
5. If Supabase does not have the object, return `404`.
6. If Supabase or the R2 write fails, return `502`.

`GET` and `HEAD` are both accepted. When syncing from Supabase, the worker always uses `GET` so it can read the full object body.

## Configuration

R2 must be configured as a Worker binding in the committed `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "OBJECT_BUCKET"
bucket_name = "your-r2-bucket-name"
```

For local development, put Supabase values in `.dev.vars`:

```env
SUPABASE_STORAGE_BASE_URL=https://<project-ref>.supabase.co/storage/v1/object/public/<bucket>
```

For a private Supabase bucket, use the non-public object URL and set a secret:

```sh
wrangler secret put SUPABASE_AUTH_TOKEN
```

If your Supabase project requires an API key header for Storage requests, set:

```sh
wrangler secret put SUPABASE_API_KEY
```

For production, store Supabase values as Worker secrets instead of committing them:

```sh
wrangler secret put SUPABASE_STORAGE_BASE_URL
wrangler secret put SUPABASE_AUTH_TOKEN
wrangler secret put SUPABASE_API_KEY
```

Optional local variable or production secret:

```env
CACHE_CONTROL=public, max-age=31536000, immutable
```

## Development

```sh
npm install
npm run dev
```

Deploy with:

```sh
npm run deploy
```
