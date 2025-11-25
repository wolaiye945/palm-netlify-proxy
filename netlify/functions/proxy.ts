import { Context } from "@netlify/edge-functions";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
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
  "host"
];

export default async (request: Request, context: Context) => {
  const reqUrl = new URL(request.url);
  const requestId = Math.random().toString(36).substring(7);

  console.log(`[${requestId}] INCOMING REQUEST: ${request.method} ${reqUrl.pathname}`);

  // 1. Handle Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // 2. Build Google URL
  const targetUrl = new URL(reqUrl.pathname, "https://generativelanguage.googleapis.com");
  reqUrl.searchParams.forEach((val, key) => {
    if (key !== "_path") targetUrl.searchParams.append(key, val);
  });

  console.log(`[${requestId}] TARGET URL: ${targetUrl.toString()}`);

  // 3. Prepare Request Headers
  const requestHeaders = new Headers();
  request.headers.forEach((val, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase()) && key !== 'host') {
      requestHeaders.set(key, val);
    }
  });
  requestHeaders.set("Host", "generativelanguage.googleapis.com");

  // Debug: Log request headers
  console.log(`[${requestId}] REQUEST HEADERS:`, Object.fromEntries(requestHeaders));

  try {
    // 4. Fetch from Google
    const fetchOptions: RequestInit = {
      method: request.method,
      headers: requestHeaders,
    };

    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      // Read body text for debugging (WARNING: This consumes the stream, so we must recreate it)
      const bodyText = await request.text();
      console.log(`[${requestId}] REQUEST BODY PAYLOAD:`, bodyText.substring(0, 500) + "..."); 
      fetchOptions.body = bodyText;
    }

    const response = await fetch(targetUrl, fetchOptions);

    console.log(`[${requestId}] GOOGLE STATUS: ${response.status} ${response.statusText}`);
    console.log(`[${requestId}] GOOGLE HEADERS:`, Object.fromEntries(response.headers));

    // 5. Intercept Response Body for Debugging
    // We read the text to see if it's an error message or empty
    const responseText = await response.text();
    console.log(`[${requestId}] GOOGLE RESPONSE BODY PREVIEW:`, responseText.substring(0, 1000));

    // 6. Prepare Response Headers
    const responseHeaders = new Headers({
      ...CORS_HEADERS,
      "content-type": response.headers.get("content-type") || "application/json"
    });

    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });

    // 7. Return the text directly (Not streaming, just for debug)
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (err) {
    console.error(`[${requestId}] FATAL ERROR:`, err);
    return new Response(JSON.stringify({ 
      error: { 
        code: 500, 
        message: String(err), 
        type: "PROXY_DEBUG_ERROR" 
      } 
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" }
    });
  }
};
