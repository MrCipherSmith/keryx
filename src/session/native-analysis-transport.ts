/** The local service transport preserves the caller's endpoint/model gate through redirects
 * and bounds the response before any Jev service can parse it. */
export async function fetchBoundedAnalysis(fetchFn: typeof fetch, input: RequestInfo | URL, init: RequestInit, outerSignal: AbortSignal, maxBytes = 512 * 1024): Promise<Response> {
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort!: (cause: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { rejectAbort(signal.reason); void reader?.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await Promise.race([fetchFn(input, { ...init, signal, redirect: "error" }), aborted]);
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw new Error("analysis-redirect-refused"); }
    if (!response.ok) { await response.body?.cancel(); return new Response('{"error":"analysis-service-rejected"}', { status: response.status, headers: { "content-type": "application/json" } }); }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) { await response.body?.cancel(); throw new Error("analysis-response-quota-exceeded"); }
    if (response.body === null) return new Response(null, { status: response.status });
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const result = await Promise.race([reader.read(), aborted]); signal.throwIfAborted();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("analysis-response-quota-exceeded"); }
      chunks.push(result.value);
    }
    return new Response(Buffer.concat(chunks, bytes), { status: response.status, headers: { "content-type": "application/json" } });
  } finally { signal.removeEventListener("abort", onAbort); try { reader?.releaseLock(); } catch { /* An aborted pending read is already cancelled. */ } }
}
