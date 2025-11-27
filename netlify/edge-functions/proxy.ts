// netlify/edge-functions/proxy.ts
import type { Context, Config } from "@netlify/edge-functions";

export default async (req: Request, context: Context) => {
  const reqId = Math.random().toString(36).substring(2, 7);
  console.log(`[${reqId}] 🔵 START: ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      }
    });
  }

  const reqUrl = new URL(req.url);
  let targetPath = reqUrl.pathname;
  if (targetPath.startsWith("/models")) targetPath = "/v1beta" + targetPath;
  
  const targetUrl = new URL(targetPath + reqUrl.search, "https://generativelanguage.googleapis.com");

  // Headers preparation
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("Host", "generativelanguage.googleapis.com");
  requestHeaders.delete("x-nf-request-id");
  requestHeaders.delete("x-forwarded-for");
  // Ensure we request SSE for keep-alive support
  if (!reqUrl.searchParams.has("alt")) {
    targetUrl.searchParams.set("alt", "sse");
  }

  // --- RETRY LOGIC ---
  let upstreamResponse;
  let attempt = 0;
  const maxAttempts = 3;

  // We need to read the body text once so we can reuse it for retries
  let bodyText: string | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
      try {
          bodyText = await req.text();
      } catch (e) {
          console.error(`[${reqId}] Failed to read request body`, e);
      }
  }

  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`[${reqId}] 🚀 Attempt ${attempt}/${maxAttempts}: ${targetUrl.toString()}`);
      
      upstreamResponse = await fetch(targetUrl, {
        method: req.method,
        headers: requestHeaders,
        body: bodyText,
      });

      if (upstreamResponse.status === 503 || upstreamResponse.status === 429) {
        console.warn(`[${reqId}] ⚠️ Google Busy (${upstreamResponse.status}). Retrying in 1s...`);
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
        continue;
      }

      break; // Success or non-retryable error
    } catch (err) {
      console.error(`[${reqId}] Network Error on attempt ${attempt}:`, err);
      if (attempt === maxAttempts) throw err;
    }
  }

  if (!upstreamResponse) return new Response("Proxy Error", { status: 502 });

  // --- STREAM HANDLER ---
  console.log(`[${reqId}] 🟢 Connected. Status: ${upstreamResponse.status}`);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Start passing data
  (async () => {
    let intervalId: number | undefined;
    try {
        // @ts-ignore
        const reader = upstreamResponse.body.getReader();
        
        // Send a keep-alive comment immediately
        await writer.write(encoder.encode(": start\n\n"));

        // Send heartbeat every 10s to prevent timeout
        intervalId = setInterval(async () => {
           try {
             // Only send if the stream is still open
             await writer.write(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
           } catch(e) { 
               clearInterval(intervalId); 
           }
        }, 10000);

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log(`[${reqId}] 🏁 Stream Done`);
                break;
            }
            await writer.write(value);
        }
    } catch (e) {
        console.error(`[${reqId}] Stream Pump Error:`, e);
    } finally {
        if (intervalId) clearInterval(intervalId);
        try { await writer.close(); } catch(_) {}
    }
  })();

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Cache-Control", "no-cache");
  responseHeaders.set("X-Accel-Buffering", "no");

  return new Response(readable, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
};

export const config: Config = { path: "/*" };
