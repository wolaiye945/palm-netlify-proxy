// netlify/functions/proxy.ts

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

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
  // DEBUGGING LOGS
  console.log(`[${new Date().toISOString()}] Method: ${req.method} | URL: ${req.url}`);

  // 1. Handle Preflight (OPTIONS)
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const reqUrl = new URL(req.url);
    
    // 2. Health Check / Root Path Handling
    if (reqUrl.pathname === "/" || reqUrl.pathname === "" || reqUrl.pathname.endsWith("/proxy")) {
       console.log("Health check detected.");
       return new Response(JSON.stringify({ status: "Alive", message: "Gemini Proxy Ready" }), {
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        status: 200
      });
    }

    // 3. Construct Target URL with INTELLIGENT PATH FIXING
    let targetPath = reqUrl.pathname;
    
    // Clean up internal Netlify paths if they appear
    if (targetPath.startsWith("/.netlify/functions/proxy")) {
        targetPath = targetPath.replace("/.netlify/functions/proxy", "");
    }

    // CRITICAL FIX: Check if the path is missing the API version
    // If it starts directly with "/models", we assume it needs "/v1beta" prepended.
    if (targetPath.startsWith("/models")) {
        console.log(`Path missing version detected: ${targetPath}. Prepending /v1beta`);
        targetPath = "/v1beta" + targetPath;
    } else if (targetPath.startsWith("/v1/")) {
        // Optional: Normalize v1 to v1beta if you want to force beta features, 
        // but usually v1 is fine if Google supports it.
        // keeping as is for now unless you want to force v1beta everywhere.
    }

    // Combine with query params (like ?alt=sse)
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

    if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.body) {
            fetchOptions.body = req.body;
            // @ts-ignore: duplex is required for streaming bodies in Node 18+
            fetchOptions.duplex = 'half'; 
        }
    }

    // 6. Execute Request
    const response = await fetch(targetUrl, fetchOptions);
    
    console.log(`Google Response: ${response.status} ${response.statusText}`);

    // 7. Handle Response Headers
    const responseHeaders = new Headers({ ...CORS_HEADERS });
    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });

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
