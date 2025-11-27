// netlify/edge-functions/proxy.ts
import type { Context, Config } from "@netlify/edge-functions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default async (req: Request, context: Context) => {
  // 1. Generate a short, readable Request ID
  const reqId = Math.random().toString(36).substring(2, 7);
  const start = Date.now();
  
  console.log(`[${reqId}] 🔵 START: ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const reqUrl = new URL(req.url);

    // --- URL Construction ---
    let targetPath = reqUrl.pathname;
    if (targetPath.startsWith("/models")) {
       console.log(`[${reqId}] 🔧 Path Fix: Prepending /v1beta`);
       targetPath = "/v1beta" + targetPath;
    }
    const targetUrl = new URL(targetPath + reqUrl.search, "https://generativelanguage.googleapis.com");
    
    // --- Headers ---
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("Host", "generativelanguage.googleapis.com");
    requestHeaders.delete("x-nf-request-id");
    requestHeaders.delete("x-forwarded-for");

    // --- Upstream Request ---
    console.log(`[${reqId}] 🚀 Fetching: ${targetUrl.toString()}`);
    
    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: requestHeaders,
      body: (req.method !== "GET" && req.method !== "HEAD") ? req.body : null,
    });

    console.log(`[${reqId}] 🟢 Google Connected. Status: ${upstreamResponse.status}`);

    if (!upstreamResponse.ok) {
        console.error(`[${reqId}] ❌ Google Error: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
        // Look for error details in body if text
        const errorText = await upstreamResponse.text();
        console.error(`[${reqId}] ❌ Error Body: ${errorText.substring(0, 200)}...`);
        return new Response(errorText, {
            status: upstreamResponse.status, 
            headers: { ...CORS_HEADERS, "content-type": "application/json" }
        });
    }

    // --- STREAM MONITORING ---
    // This TransformStream sits between Google and the Client
    let totalBytes = 0;
    let chunkCount = 0;
    let lastChunkTime = Date.now();

    const streamMonitor = new TransformStream({
      start(controller) {
        console.log(`[${reqId}] 🌊 Stream Pipe OPENED`);
      },
      transform(chunk, controller) {
        chunkCount++;
        totalBytes += chunk.length;
        const now = Date.now();
        const timeSinceLast = now - lastChunkTime;
        lastChunkTime = now;

        // Log every 5th chunk OR if there was a significant pause (>2 seconds)
        if (chunkCount % 5 === 0 || timeSinceLast > 2000) {
             console.log(`[${reqId}] 📦 Chunk #${chunkCount} | Size: ${chunk.length}b | Total: ${totalBytes}b | Latency: ${timeSinceLast}ms`);
        }
        
        controller.enqueue(chunk);
      },
      flush(controller) {
        const duration = Date.now() - start;
        console.log(`[${reqId}] 🏁 Stream FLUSHED (Normal Finish). Total Duration: ${duration}ms. Total Bytes: ${totalBytes}`);
      },
      cancel(reason) {
          // This triggers if the CLIENT disconnects or the browser stops reading
          const duration = Date.now() - start;
          console.warn(`[${reqId}] ⚠️ Stream CANCELED by Client/Netlify. Reason: ${reason}. Duration: ${duration}ms`);
      }
    });

    // --- Response Headers ---
    const responseHeaders = new Headers(upstreamResponse.headers);
    Object.entries(CORS_HEADERS).forEach(([key, value]) => responseHeaders.set(key, value));
    responseHeaders.set("Cache-Control", "no-cache");
    responseHeaders.set("X-Accel-Buffering", "no");

    // Pipe the Google body through our monitor
    // @ts-ignore
    const monitoredBody = upstreamResponse.body.pipeThrough(streamMonitor);

    return new Response(monitoredBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${reqId}] 💥 CRITICAL EXCEPTION:`, error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/*",
};
