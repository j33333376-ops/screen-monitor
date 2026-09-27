// Saved high-resolution JPEGs are independent of live screen frames.
function createCaptureRequests({ send, timeoutMs = 8000 }) {
  let serial = 0;
  function request(session, student) {
    if (student.highRequest) return student.highRequest.promise;
    const ws = student.ws;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.resolve(null);
    const id = serial = (serial + 1) >>> 0 || 1;
    let complete;
    const promise = new Promise(resolve => { complete = resolve; });
    const pending = { id, ws, promise, finish(bytes) {
      if (student.highRequest !== pending) return;
      clearTimeout(pending.timer);
      student.highRequest = null;
      complete(bytes);
    } };
    student.highRequest = pending;
    pending.timer = setTimeout(() => pending.finish(null), timeoutMs);
    send(ws, { t: 'capture', requestId: id, maxEdge: 2560, quality: 85 });
    return promise;
  }
  function accept(student, id, bytes) {
    const pending = student.highRequest;
    if (pending && pending.id === id && pending.ws === student.ws) pending.finish(bytes);
  }
  function cancel(student) { student.highRequest?.finish(null); }
  return { request, accept, cancel };
}
module.exports = { createCaptureRequests };
