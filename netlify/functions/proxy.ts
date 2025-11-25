import { Context } from "@netlify/edge-functions";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

// Headers we must NEVER forward from the upstream (Google) response
// because Netlify/Browser handles them automatically.
const HOP_BY_HOP_HEADERS = [
  "keep-alive",
  "transfer-encoding",
  "te",
  "connection",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "content-encoding", // Critical: Netlify decompresses; forwarding this breaks the client
  "content-length",   // Critical: Stream length is unknown
  "host"
];

export default async (request: Request, context: Context) => {
  
  // 1. Handle Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const reqUrl = new URL(request.url);
  
  // 2. Root Path Info
  if (reqUrl.pathname === "/") {
    return new Response("Gemini Proxy Operational", { 
      headers: { ...CORS_HEADERS, "content-type": "text/plain" } 
    });
  }

  // 3. Build Google URL
  // We map the path directly: /v1beta/... -> https://generativelanguage.googleapis.com/v1beta/...
  const targetUrl = new URL(reqUrl.pathname, "https://generativelanguage.googleapis.com");
  
  // Forward search params (api_key, etc.)
  reqUrl.searchParams.forEach((val, key) => {
    if (key !== "_path") targetUrl.searchParams.append(key, val);
  });

  // 4. Prepare Request Headers
  // We forward almost everything from the client to Google to ensure auth/client headers work.
  const requestHeaders = new Headers();
  request.headers.forEach((val, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase()) && key !== 'host') {
      requestHeaders.set(key, val);
    }
  });

  // Ensure host is set correctly for Google
  requestHeaders.set("Host", "generativelanguage.googleapis.com");

  try {
    // 5. Fetch from Google
    const fetchOptions: RequestInit = {
      method: request.method,
      headers: requestHeaders,
      // @ts-ignore - Deno/Netlify support duplex for streaming bodies
      duplex: "half" 
    };

    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
    }

    const response = await fetch(targetUrl, fetchOptions);

    // 6. Prepare Response Headers
    // We forward headers using an Exclusion list (Blacklist) strategy.
    // This ensures 'x-goog-*' headers are preserved.
    const responseHeaders = new Headers({
      ...CORS_HEADERS, 
      // Force content-type if Google provided it, otherwise default to json for safety
      "content-type": response.headers.get("content-type") || "application/json"
    });

    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });

    // 7. Return the Stream
    // If Google returns a 4xx/5xx, we still forward the body so the client app 
    // can parse the error message (e.g., "Invalid API Key").
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (err) {
    // Fallback error
    return new Response(JSON.stringify({ 
      error: { 
        code: 500, 
        message: String(err), 
        status: "INTERNAL_PROXY_ERROR" 
      } 
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" }
    });
  }
};
