import { Context } from "@netlify/edge-functions";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
};

// Headers to block to ensure clean streaming
const HOP_BY_HOP_HEADERS = [
  "keep-alive",
  "transfer-encoding",
  "te",
  "connection",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "content-encoding",
  "content-length",
  "host"
];

export default async (request: Request, context: Context) => {
  const reqUrl = new URL(request.url);

  // 1. Handle Preflight (OPTIONS)
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // 2. Handle Root Connection Check (CRITICAL FIX)
  // Cherry Studio pings this to check if the server is alive.
  if (reqUrl.pathname === "/" || reqUrl.pathname === "") {
    return new Response(JSON.stringify({ status: "Alive", message: "Gemini Proxy Ready" }), {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      status: 200
    });
  }

  // 3. Build Target URL
  // We map the path exactly. Example: /v1beta/models -> https://generativelanguage.googleapis.com/v1beta/models
  const targetUrl = new URL(reqUrl.pathname, "https://generativelanguage.googleapis.com");
  
  reqUrl.searchParams.forEach((val, key) => {
    // Filter out Netlify specific params if any
    if (key !== "_path") targetUrl.searchParams.append(key, val);
  });

  // 4. Prepare Request Headers
  const requestHeaders = new Headers();
  request.headers.forEach((val, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase()) && key !== 'host') {
      requestHeaders.set(key, val);
    }
  });
  // Force the correct host for Google
  requestHeaders.set("Host", "generativelanguage.googleapis.com");

  try {
    // 5. Fetch from Google
    const fetchOptions: RequestInit = {
      method: request.method,
      headers: requestHeaders,
    };

    // Attach body only for non-GET requests
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
        fetchOptions.body = request.body;
        // @ts-ignore - Deno/Netlify support duplex
        fetchOptions.duplex = "half"; 
    }

    const response = await fetch(targetUrl, fetchOptions);

    // 6. Prepare Response Headers (Exclusion List Strategy)
    const responseHeaders = new Headers({
      ...CORS_HEADERS,
      // Default to json if missing, but usually Google sends it
      "content-type": response.headers.get("content-type") || "application/json"
    });

    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });

    // 7. Stream the Response Back
    // We return the body directly. This enables streaming.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (err) {
    // Return a clean JSON error if the fetch fails completely
    return new Response(JSON.stringify({ 
      error: { 
        code: 500, 
        message: "Proxy Error: " + String(err), 
        status: "INTERNAL_ERROR" 
      } 
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" }
    });
  }
};
