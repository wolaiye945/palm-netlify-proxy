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
  const reqId = Math.random().toString(36).substring(7); // Random ID to track requests in logs
  console.log(`[${reqId}] Request Started: ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const reqUrl = new URL(req.url);
    
    // --- PATH CORRECTION LOGIC ---
    let targetPath = reqUrl.pathname;
    if (targetPath.startsWith("/.netlify/functions/proxy")) {
        targetPath = targetPath.replace("/.netlify/functions/proxy", "");
    }
    // Fix missing version
    if (targetPath.startsWith("/models")) {
        console.log(`[${reqId}] Fix: Prepending /v1beta to path`);
        targetPath = "/v1beta" + targetPath;
    }
    
    const targetUrl = new URL(targetPath + reqUrl.search, "https://generativelanguage.googleapis.com");
    console.log(`[${reqId}] Proxy Target: ${targetUrl.toString()}`);

    // --- HEADER PREPARATION ---
    const requestHeaders = new Headers();
    req.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        requestHeaders.set(key, val);
      }
    });
    requestHeaders.set("Host", "generativelanguage.googleapis.com");

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: requestHeaders,
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
        fetchOptions.body = req.body;
        // @ts-ignore: Node 18+ requirement
        fetchOptions.duplex = 'half'; 
    }

    // --- SEND TO GOOGLE ---
    const startTime = Date.now();
    const response = await fetch(targetUrl, fetchOptions);
    
    console.log(`[${reqId}] Google Status: ${response.status}`);

    // --- RESPONSE HANDLING ---
    const responseHeaders = new Headers({ ...CORS_HEADERS });
    response.headers.forEach((val, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, val);
      }
    });

    // Force headers to prevent buffering and timeouts if possible
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("X-Accel-Buffering", "no"); // Nginx hint
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", response.headers.get("content-type") || "application/json");
    }

    // --- STREAM DEBUGGING MONITOR ---
    // We create a TransformStream to count chunks passing through without modifying them.
    // This helps us see if the stream dies in the middle.
    let chunkCount = 0;
    let byteCount = 0;

    const { readable, writable } = new TransformStream({
      transform(chunk, controller) {
        chunkCount++;
        byteCount += chunk.length;
        // Log every 20 chunks to avoid flooding logs, but show activity
        if (chunkCount % 20 === 0) {
            console.log(`[${reqId}] Stream active: ${chunkCount} chunks, ${byteCount} bytes...`);
        }
        controller.enqueue(chunk);
      },
      flush() {
        const duration = Date.now() - startTime;
        console.log(`[${reqId}] Stream COMPLETE. Total: ${chunkCount} chunks, ${byteCount} bytes. Duration: ${duration}ms`);
        if (duration > 9500) {
             console.warn(`[${reqId}] WARNING: Duration close to Netlify 10s limit!`);
        }
      }
    });

    // If response has a body, pipe it through our monitor
    let finalBody = response.body;
    if (response.body) {
        // @ts-ignore
        response.body.pipeTo(writable).catch(err => {
            console.error(`[${reqId}] Stream Broken/Interrupted:`, err);
        });
        finalBody = readable;
    }

    return new Response(finalBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${reqId}] CRITICAL ERROR:`, error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
};
