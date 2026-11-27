/** Await close (not merely exit) before the caller removes child-owned temporary files. */
export function waitForChild(child, timeoutMs, graceMs = 5000) {
  return new Promise((resolve, reject) => {
    let reason, escalation;
    const terminate = message => {
      reason ??= new Error(message);
      if (escalation) return;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), graceMs);
    };
    const interrupt = () => terminate('Electron cancelled');
    const timer = setTimeout(() => terminate('Electron timeout'), timeoutMs);
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (spawnError) reject(spawnError);
      else if (reason) reject(reason);
      else if (signal) reject(new Error(`Electron exited by ${signal}`));
      else resolve(code);
    });
  });
}
