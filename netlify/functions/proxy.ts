import { Context } from "@netlify/edge-functions";

const pickHeaders = (headers: Headers, keys: (string | RegExp)[]): Headers => {
  const picked = new Headers();
  for (const key of headers.keys()) {
    if (keys.some((k) => (typeof k === "string" ? k === key : k.test(key)))) {
      const value = headers.get(key);
      if (typeof value === "string") {
        picked.set(key, value);
      }
    }
  }
  return picked;
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

export default async (request: Request, context: Context) => {

  // 1. Handle Preflight Options
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  }

  const { pathname, searchParams } = new URL(request.url);

  // 2. Handle Root/Info Page
  if(pathname === "/") {
    let blank_html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Gemini/PaLM API Proxy</title>
</head>
<body>
  <h1>Gemini API Proxy Active</h1>
  <p>Status: Running on Netlify Edge</p>
</body>
</html>
    `
    return new Response(blank_html, {
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/html"
      },
    });
  }

  // 3. Construct Target URL
  // Note: Using 'generativelanguage.googleapis.com' is correct for Gemini
  const url = new URL(pathname, "https://generativelanguage.googleapis.com");
  searchParams.delete("_path");

  searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });

  // 4. Prepare Request Headers
  // We explicitly forward the API Key and Client headers. 
  // We DO NOT forward 'host' or 'content-length' to let fetch handle those.
  const requestHeaders = pickHeaders(request.headers, [
    "content-type", 
    "authorization", 
    "x-goog-api-client", 
    "x-goog-api-key", 
    "accept-encoding" // Important: Let Google know if we accept gzip, though Netlify handles decoding usually.
  ]);

  try {
    // 5. Fetch from Google
    // 'duplex' is required for streaming bodies in some environments, but standard fetch often implies it.
    // If 'duplex: half' was causing issues, removing it usually defaults to standard behavior.
    // However, for Node 18+ native fetch, duplex: 'half' is often required if sending a body. 
    // We will keep it but ensure body handling is robust.
    
    // Check if we have a body to forward
    const fetchOptions: RequestInit = {
        method: request.method,
        headers: requestHeaders,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchOptions.body = request.body;
        // @ts-ignore - Netlify Edge uses Deno-style fetch where duplex might be needed
        fetchOptions.duplex = "half"; 
    }

    const response = await fetch(url, fetchOptions);

    // 6. Handle Response Headers
    // CRITICAL FIX: Do not forward 'content-encoding' or 'transfer-encoding'. 
    // Netlify's edge layer acts as a middleman. If Google sends back gzipped data, 
    // Netlify decodes it. If we tell the client "this is gzipped" via headers but pass 
    // decoded text, the client breaks.
    
    const responseHeaders = new Headers(CORS_HEADERS);
    
    // Forward specific safe headers
    const safeResponseHeaders = [
        "content-type",
        "cache-control",
        "date",
        "server",
        "vary"
    ];

    safeResponseHeaders.forEach(key => {
        const val = response.headers.get(key);
        if(val) responseHeaders.set(key, val);
    });

    // 7. Return Response
    // We pass response.body directly to support streaming
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText
    });

  } catch (error) {
    // Error handling
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { 
          ...CORS_HEADERS,
          "content-type": "application/json"
      }
    });
  }
};
