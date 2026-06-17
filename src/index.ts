declare const __DEV__: boolean;

interface Env {
  OBJECT_BUCKET: R2Bucket;
  SUPABASE_STORAGE_BASE_URL: string;
  SUPABASE_API_KEY?: string;
  SUPABASE_AUTH_TOKEN?: string;
  CACHE_CONTROL?: string;
  CF_PURGE_API_TOKEN?: string;
  CF_PURGE_ZONE_ID?: string;
  CF_PURGE_BASE_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsOrigin = resolveCorsOrigin(request, env);

    if (request.method === "OPTIONS") {
      return corsPreflight(request, corsOrigin);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return withCors(
        new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD, OPTIONS" }
        }),
        corsOrigin
      );
    }

    if (isWellKnownRequest(request.url)) {
      return withCors(new Response(null, { status: 204 }), corsOrigin);
    }

    const key = getObjectKey(request.url);
    if (!key) {
      return withCors(notFound(), corsOrigin);
    }

    devLog("object sync", {
      key,
      supabase: "fetching"
    });

    const upstreamResponse = await fetchFromSupabase(key, env);
    if (!upstreamResponse.ok) {
      if (await isUpstreamNotFound(upstreamResponse)) {
        devLog("object sync", {
          key,
          supabase: "miss",
          upstreamStatus: upstreamResponse.status,
          status: 404
        });
        return withCors(notFound(), corsOrigin);
      }

      console.error("object sync", {
        key,
        supabase: "error",
        upstreamStatus: upstreamResponse.status,
        status: 502
      });
      return withCors(new Response("Upstream storage error", { status: 502 }), corsOrigin);
    }

    try {
      await syncToR2(key, upstreamResponse, env);
      await purgeCloudflareCache(request.url, env);
      devLog("object sync", {
        key,
        supabase: "synced",
        upstreamStatus: upstreamResponse.status,
        status: 200
      });
      return withCors(ok(), corsOrigin);
    } catch (error) {
      console.error("Failed to sync object to R2 or purge cache", { key, error });
      return withCors(new Response("Sync failed", { status: 502 }), corsOrigin);
    }
  }
};

function devLog(...args: unknown[]): void {
  if (__DEV__) {
    console.log(...args);
  }
}

function isWellKnownRequest(requestUrl: string): boolean {
  const { pathname } = new URL(requestUrl);
  return pathname === "/.well-known" || pathname.startsWith("/.well-known/");
}

function getObjectKey(requestUrl: string): string | null {
  const { pathname } = new URL(requestUrl);
  const key = pathname.replace(/^\/+/, "");

  if (!key || key.endsWith("/")) {
    return null;
  }

  try {
    return decodeURIComponent(key);
  } catch {
    return null;
  }
}

function ok(): Response {
  return new Response(null, { status: 200 });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function isUpstreamNotFound(response: Response): Promise<boolean> {
  if (response.status === 404) {
    return true;
  }

  if (response.status !== 400) {
    return false;
  }

  const body = await response.clone().text();
  return /object not found|not found|nosuchkey/i.test(body);
}

async function fetchFromSupabase(key: string, env: Env): Promise<Response> {
  const baseUrl = env.SUPABASE_STORAGE_BASE_URL.replace(/\/+$/, "");
  const url = `${baseUrl}/${encodePathSegments(key)}`;
  const headers = new Headers();

  if (env.SUPABASE_API_KEY) {
    headers.set("apikey", env.SUPABASE_API_KEY);
  }

  if (env.SUPABASE_AUTH_TOKEN) {
    headers.set("authorization", `Bearer ${env.SUPABASE_AUTH_TOKEN}`);
  }

  return fetch(url, { method: "GET", headers });
}

async function syncToR2(key: string, response: Response, env: Env): Promise<void> {
  if (!response.body) {
    throw new Error("empty response body");
  }

  await env.OBJECT_BUCKET.put(key, response.body, {
    httpMetadata: {
      contentType: response.headers.get("content-type") ?? undefined,
      contentLanguage: response.headers.get("content-language") ?? undefined,
      contentDisposition: response.headers.get("content-disposition") ?? undefined,
      contentEncoding: response.headers.get("content-encoding") ?? undefined,
      cacheControl: response.headers.get("cache-control") ?? env.CACHE_CONTROL ?? undefined
    }
  });
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function purgeCloudflareCache(requestUrl: string, env: Env): Promise<void> {
  if (!env.CF_PURGE_API_TOKEN || !env.CF_PURGE_ZONE_ID) {
    devLog("cache purge skipped", { url: requestUrl, reason: "missing credentials" });
    return;
  }

  const url = getPurgeUrl(requestUrl, env);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_PURGE_ZONE_ID}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_PURGE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ files: [url] })
    }
  );

  const result = (await response.json()) as CloudflareApiResponse;

  if (!response.ok || !result.success) {
    const details =
      result.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") ??
      `HTTP ${response.status}`;
    throw new Error(`Cloudflare purge failed for ${url}: ${details}`);
  }

  devLog("cache purge", { url, status: "purged" });
}

interface CloudflareApiResponse {
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
}

function getPurgeUrl(requestUrl: string, env: Env): string {
  if (env.CF_PURGE_BASE_URL) {
    const base = env.CF_PURGE_BASE_URL.replace(/\/+$/, "");
    const { pathname, search } = new URL(requestUrl);
    return `${base}${pathname}${search}`;
  }

  return requestUrl;
}

function parseAllowedOrigins(value: string | undefined): string[] | null {
  if (!value) {
    return null;
  }

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : null;
}

function resolveCorsOrigin(request: Request, env: Env): string | null {
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  if (!allowedOrigins) {
    return null;
  }

  const origin = request.headers.get("Origin");
  if (!origin) {
    return null;
  }

  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    return origin;
  }

  return null;
}

function applyCorsHeaders(headers: Headers, corsOrigin: string): void {
  headers.set("Access-Control-Allow-Origin", corsOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  appendVary(headers, "Origin");
}

function corsPreflight(request: Request, corsOrigin: string | null): Response {
  if (!corsOrigin) {
    return new Response(null, { status: 405 });
  }

  const headers = new Headers({
    "Access-Control-Max-Age": "86400"
  });
  applyCorsHeaders(headers, corsOrigin);

  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  if (requestHeaders) {
    headers.set("Access-Control-Allow-Headers", requestHeaders);
  }

  return new Response(null, { status: 204, headers });
}

function withCors(response: Response, corsOrigin: string | null): Response {
  if (!corsOrigin) {
    return response;
  }

  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, corsOrigin);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }

  const values = existing.split(",").map((entry) => entry.trim());
  if (!values.includes(value)) {
    headers.set("Vary", `${existing}, ${value}`);
  }
}
