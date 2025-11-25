import type { Context } from "@netlify/functions";

// Headers to block/filter so we don't confuse the browser or Google
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default async (req: Request, context: Context) => {
  const startTime = Date.now();
  const reqUrl = new URL(req.url);
  
  // --- LOGGING START ---
  console.log(`[${new Date().toISOString()}] INCOMING REQUEST`);
  console.log(`Method: ${req.method}`);
  console.log(`Original URL: ${req.url}`);
  console.log(`Pathname: ${reqUrl.pathname}`);
  // --- LOGGING END ---

  // 1. Handle Preflight (OPTIONS)
  if (req.method === "OPTIONS") {
    console.log("Handling OPTIONS preflight request.");
    return new Response(null, { headers: CORS_HEADERS });
  }

  // 2. Handle Connection Check (Root Path or Health Check)
  // We log this specifically to debug if Cherry Studio is "Seeing" the server.
  if (reqUrl.pathname === "/" || reqUrl.pathname === "" || (!reqUrl.pathname.includes("/v1") && !reqUrl.pathname.includes("/models"))) {
     console.log("Root path detected. Sending 'Alive' message.");
     return new Response(JSON.stringify({ status: "Alive", message: "Gemini Proxy Ready (Node.js)" }), {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      status: 200
    });
  }

  // 3. Build Target URL
  // We strip the origin and point it to Google
  const targetUrl = new URL(reqUrl.pathname + reqUrl.search, "https://generativelanguage.googleapis.com");
  console.log(`Target URL Constructed: ${targetUrl.toString()}`);

  // 4. Prepare Request Headers
  const requestHeaders = new Headers();
  req.headers.forEach((val, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      requestHeaders.set(key, val);
    }
  });
  requestHeaders.set("Host", "generativelanguage.googleapis.com");
  
  // Log Headers (Masking API Key for security in logs)
  const authHeader = requestHeaders.get("x-goog-api-key") || requestHeaders.get("authorization");
  console.log("Request Headers being sent to Google:", {
    ...Object.fromEntries(requestHeaders.entries()),
    "x-goog-api-key": authHeader ? "(PRESENT - MASKED)" : "(MISSING)",
    "authorization": authHeader ? "(PRESENT - MASKED)" : "(MISSING)"
  });

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: requestHeaders,
      body: req.body, 
      // @ts-ignore: Node 18+ duplex requirement for streaming bodies
      duplex: 'half' 
    };

    console.log("Sending fetch request to Google...");

    // 5. Fetch from Google
    const response = await fetch(targetUrl, fetchOptions);

    console.log(`Google Response Status: ${response.status} ${response.statusText}`);

    // 6. Prepare Response Headers
    const responseHeaders = new Headers({
      ...CORS_HEADERS,
    });

    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });
    
    // Ensure content-type is set
    if (!responseHeaders.has("content-type")) {
        const contentType = response.headers.get("content-type") || "application/json";
        responseHeaders.set("content-type", contentType);
        console.log(`Set default content-type: ${contentType}`);
    }

    console.log(`[${new Date().toISOString()}] Request Completed in ${Date.now() - startTime}ms`);

    // 7. Return Response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error("CRITICAL PROXY ERROR:", error);
    return new Response(JSON.stringify({ error: String(error), details: "Check Netlify Function Logs" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
};

// Configure the function to use the standard Request/Response API
// and handle all paths
export const config = {
  path: "/*"
};
