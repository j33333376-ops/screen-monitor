// Keep a bounded, in-memory view of this class's actual recording captures.
function createHistory({ maxBytes, maxFrames = 3000, notify }) {
  const entries = new Map();
  let bytes = 0, nextId = 1;
  function discard(frame) {
    entries.delete(frame.id);
    bytes -= frame.bytes.length;
    const frames = frame.student.history;
    frames.splice(frames.indexOf(frame), 1);
  }
  function add(session, student, data, at) {
    if (data.length > maxBytes) return;
    const changed = new Map();
    const mark = (s, st) => {
      if (!changed.has(s)) changed.set(s, new Set());
      changed.get(s).add(st.id);
    };
    const frames = student.history ||= [];
    while (bytes + data.length > maxBytes || frames.length >= maxFrames) {
      const oldest = frames.length >= maxFrames ? frames[0] : entries.values().next().value;
      mark(oldest.session, oldest.student);
      discard(oldest);
    }
    const frame = { id: nextId++, at, bytes: data, session, student };
    frames.push(frame);
    entries.set(frame.id, frame);
    bytes += data.length;
    mark(session, student);
    for (const [s, ids] of changed) for (const id of ids) notify(s, id);
  }
  function clearStudent(student) {
    for (const frame of [...(student.history || [])]) discard(frame);
  }
  return { add, clearStudent };
}

module.exports = { createHistory };
