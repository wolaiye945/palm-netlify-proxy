// netlify/functions/proxy.ts

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Headers we do not want to forward to Google
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
  "host",
  "x-forwarded-for",
  "x-forwarded-proto"
];

export default async (req: Request) => {
  const startTime = Date.now();
  
  // DEBUGGING LOGS
  console.log(`[${new Date().toISOString()}] Method: ${req.method} | URL: ${req.url}`);

  // 1. Handle Preflight (OPTIONS)
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const reqUrl = new URL(req.url);
    
    // 2. Health Check / Root Path Handling
    // If the path is empty, root, or just checking availability
    if (reqUrl.pathname === "/" || reqUrl.pathname === "" || reqUrl.pathname.endsWith("/proxy")) {
       console.log("Health check detected.");
       return new Response(JSON.stringify({ status: "Alive", message: "Gemini Proxy Ready" }), {
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        status: 200
      });
    }

    // 3. Construct Target URL
    // We assume the request is like: https://your-site.com/v1beta/models/...
    // We want: https://generativelanguage.googleapis.com/v1beta/models/...
    
    // NOTE: When using netlify.toml rewrites, req.url might be the internal path.
    // We extract the useful part of the path.
    // We look for '/v1' or '/v1beta' to start the path mapping.
    
    let targetPath = reqUrl.pathname;
    
    // Fix for double slashes or internal netlify paths
    if (targetPath.startsWith("/.netlify/functions/proxy")) {
        // If the URL is the internal function path, we might be losing the original path.
        // But usually, the client sends the full path.
        // Let's try to extract the API version part.
        const apiIndex = targetPath.indexOf("/v1");
        if (apiIndex !== -1) {
            targetPath = targetPath.substring(apiIndex);
        }
    }

    const targetUrl = new URL(targetPath + reqUrl.search, "https://generativelanguage.googleapis.com");
    console.log(`Proxying to: ${targetUrl.toString()}`);

    // 4. Prepare Headers
    const requestHeaders = new Headers();
    req.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        requestHeaders.set(key, val);
      }
    });
    requestHeaders.set("Host", "generativelanguage.googleapis.com");

    // 5. Prepare Fetch Options
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: requestHeaders,
    };

    // ONLY attach body if method is NOT GET/HEAD
    // Attaching a body to GET causes Node to crash.
    if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.body) {
            fetchOptions.body = req.body;
            // @ts-ignore: duplex is required for streaming bodies in Node 18+
            fetchOptions.duplex = 'half'; 
        }
    }

    // 6. Execute Request
    const response = await fetch(targetUrl, fetchOptions);
    
    console.log(`Google Response: ${response.status}`);

    // 7. Handle Response Headers
    const responseHeaders = new Headers({ ...CORS_HEADERS });
    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });

    // Ensure content-type exists
    if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", response.headers.get("content-type") || "application/json");
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error("PROXY ERROR:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
};
