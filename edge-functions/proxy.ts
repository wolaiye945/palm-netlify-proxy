// netlify/edge-functions/proxy.ts
import type { Context, Config } from "@netlify/edge-functions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default async (req: Request, context: Context) => {
  const reqId = Math.random().toString(36).substring(7);
  console.log(`[${reqId}] Edge Request: ${req.method} ${req.url}`);

  // 1. Handle Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const reqUrl = new URL(req.url);

    // 2. Health Check
    if (reqUrl.pathname === "/" || reqUrl.pathname === "" || reqUrl.pathname.endsWith("/proxy")) {
      return new Response(JSON.stringify({ status: "Alive", mode: "Edge" }), {
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        status: 200
      });
    }

    // 3. Construct Target URL
    // Deno/Edge URL handling is cleaner, but we still need the /v1beta fix
    let targetPath = reqUrl.pathname;
    
    // Path Correction Logic
    if (targetPath.startsWith("/models")) {
       console.log(`[${reqId}] Fix: Prepending /v1beta to path`);
       targetPath = "/v1beta" + targetPath;
    }

    const targetUrl = new URL(targetPath + reqUrl.search, "https://generativelanguage.googleapis.com");
    console.log(`[${reqId}] Proxying to: ${targetUrl.toString()}`);

    // 4. Prepare Headers
    // We clone headers but remove Host and other hop-by-hop headers manually if needed
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("Host", "generativelanguage.googleapis.com");
    requestHeaders.delete("x-nf-request-id"); // Remove Netlify specific headers
    requestHeaders.delete("x-forwarded-for");

    // 5. Prepare Body
    // For Edge Functions, we can often pass the body stream directly
    const body = (req.method !== "GET" && req.method !== "HEAD") ? req.body : null;

    // 6. Execute Request to Google
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: requestHeaders,
      body: body,
    });

    console.log(`[${reqId}] Google Response: ${response.status}`);

    // 7. Prepare Response Headers
    const responseHeaders = new Headers(response.headers);
    
    // Apply CORS
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });
    
    // Force Streaming Headers
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("X-Accel-Buffering", "no"); 

    // 8. Return Response (Streaming)
    // Edge functions handle streaming natively by passing the response body
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${reqId}] EDGE ERROR:`, error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
};

// This config is optional but good practice in Deno
export const config: Config = {
  path: "/*",
};
