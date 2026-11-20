// The only script evaluated by the opaque document. The snapshot and generated
// worker source travel exclusively via structured clone, never via HTML.
export function brokerDocument(): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<script nonce="${nonce}">
  addEventListener('message', function start(event) {
    if (event.source !== parent || event.ports.length !== 1) return;
    removeEventListener('message', start);
    const host = event.ports[0];
    const { workerSource, files, assets, seed, timeout } = event.data;
    const channel = new MessageChannel();
    let worker, url, timer;
    function finish(data, transfer) {
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      channel.port1.close();
      channel.port2.close();
      host.postMessage(data, transfer);
      host.close();
    }
    const failure = () => finish(['error', 'runtime', 'Unable to run the sandbox worker'], []);
    try {
      url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      // Chromium rejects an opaque blob as a top-level module worker. The
      // trusted bootstrap is classic; it still loads authored code as ESM.
      worker = new Worker(url);
      worker.onerror = event => { event.preventDefault(); failure(); };
      channel.port1.onmessageerror = failure;
      channel.port1.onmessage = ({ data }) => finish(data, data[0] === 'ok' ? [data[1]] : []);
      timer = setTimeout(() => finish(['error', 'limit', 'Playground execution deadline exceeded'], []), timeout);
      worker.postMessage({ files, assets, seed }, [channel.port2]);
    } catch { failure(); }
  });
</script>`;
}
