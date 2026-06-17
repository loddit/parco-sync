declare const __DEV__: boolean;

interface Env {
  OBJECT_BUCKET: R2Bucket;
  SUPABASE_STORAGE_BASE_URL: string;
  SUPABASE_API_KEY?: string;
  SUPABASE_AUTH_TOKEN?: string;
  CACHE_CONTROL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" }
      });
    }

    if (isWellKnownRequest(request.url)) {
      return new Response(null, { status: 204 });
    }

    const key = getObjectKey(request.url);
    if (!key) {
      return notFound();
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
        return notFound();
      }

      console.error("object sync", {
        key,
        supabase: "error",
        upstreamStatus: upstreamResponse.status,
        status: 502
      });
      return new Response("Upstream storage error", { status: 502 });
    }

    try {
      await syncToR2(key, upstreamResponse, env);
      devLog("object sync", {
        key,
        supabase: "synced",
        upstreamStatus: upstreamResponse.status,
        status: 200
      });
      return ok();
    } catch (error) {
      console.error("Failed to sync object to R2", { key, error });
      return new Response("Sync failed", { status: 502 });
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
