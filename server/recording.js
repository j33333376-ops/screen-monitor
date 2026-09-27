// Standard captures stay in memory. AI captures are spooled to disk until PDF creation.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { normalizeLessonTitle, lessonFilenamePart } = require('./lesson-title');
const safe = (value, max = 20) => String(value ?? '').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, '').replace(/[. ]+$/g, '').slice(0, max) || '_';
const pad = (n) => String(n).padStart(2, '0');

function createRecorder({ dir, intervalMs, intervalChoices = [], maxBytes, notify, onCapture = () => {}, fetchCapture = async () => null }) {
  let bufferedBytes = 0;
  // 수업마다 캡처 주기를 따로 고르므로, 서버 기본값은 새 수업의 출발값으로만 쓴다.
  const period = (s) => s.saveIntervalMs || intervalMs;
  function info(s) {
    const warnings = [];
    if (s.saveQuality === 'ai') {
      const old = [...s.students.values()].filter(st => st.ws && !st.highCapture);
      if (old.length) warnings.push(`구버전 학생 앱 ${old.length}명은 기본 화질로 저장됩니다. 학생 앱을 업데이트하세요.`);
      if (s.missedCaptures) warnings.push(`고화질 캡처 ${s.missedCaptures}회 수신 실패 · 연결 상태를 확인하세요.`);
      if (s.spoolError) warnings.push('임시 캡처 저장 실패 · 디스크 공간/경로를 확인하세요. 남은 기록을 PDF로 저장합니다.');
    }
    return { on: s.saveOn, busy: !!s.savePromise, retry: !!s.saveBatch, quality: s.saveQuality || 'standard',
      warning: warnings.join(' '), error: s.saveError || '', result: s.saveResult || '',
      intervalSec: period(s) / 1000, intervalChoices, dir };
  }
  function start(s, quality = s.saveQuality || 'standard') {
    if (s.saveOn || s.savePromise || s.saveBatch || !['standard', 'ai'].includes(quality)) return false;
    const now = new Date();
    s.saveStamp = { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${crypto.randomBytes(4).toString('hex')}` };
    s.saveQuality = quality;
    s.spoolDir = path.join(dir, '.pending', `${s.saveStamp.date}_${s.saveStamp.time}_${safe(s.code)}`);
    s.pendingWrites = new Set();
    s.missedCaptures = 0; s.spoolError = false;
    s.saveOn = true; s.saveStopping = false;
    s.saveError = ''; s.saveResult = '';
    s.nextSaveAt = Date.now() + period(s);
    for (const st of s.students.values()) { st.frames = []; st.savedHash = null; }
    return true;
  }
  function append(s, st, jpeg, at) {
    const hash = crypto.createHash('sha256').update(jpeg).digest('hex');
    if (hash === st.savedHash) return;
    if (bufferedBytes + jpeg.length > maxBytes || st.frames.length >= 3000) return 'limit';
    const bytes = Uint8Array.from(jpeg);
    bufferedBytes += bytes.length;
    st.savedHash = hash;
    if (s.saveQuality === 'ai') {
      const frame = { bytes, file: path.join(s.spoolDir, `${st.id}_${st.frames.length + 1}.jpg`), at };
      st.frames.push(frame);
      const writing = (async () => {
        try {
          await fs.mkdir(s.spoolDir, { recursive: true });
          await fs.writeFile(frame.file, bytes);
          frame.bytes = null;
          bufferedBytes -= bytes.length;
        } catch (error) {
          // Keep the JPEG in memory so PDF saving/retry can still recover it.
          s.spoolError = true;
          console.error('[고화질 임시 저장 오류]', error.message);
          notify(s);
        }
      })().finally(() => s.pendingWrites.delete(writing));
      s.pendingWrites.add(writing);
    } else st.frames.push(bytes);
    onCapture(s, st, bytes, at);
  }
  function capture(s, st) {
    if (!s.saveOn || !st.ws || st.paused) return;
    if (s.saveQuality !== 'ai' || !st.highCapture) {
      if (st.lastThumb) return append(s, st, st.lastThumb, st.lastFrameAt || Date.now());
      return;
    }
    if (st.capturePromise) return st.capturePromise;
    const ws = st.ws;
    st.capturePromise = Promise.resolve().then(() => fetchCapture(s, st)).then(jpeg => {
      if (!s.saveOn || st.ws !== ws || st.paused) return;
      if (!jpeg) { s.missedCaptures++; notify(s); return; }
      return append(s, st, jpeg, Date.now());
    }).catch(error => {
      s.missedCaptures++; notify(s);
      console.error('[고화질 캡처 오류]', error.message);
    }).finally(() => { st.capturePromise = null; });
    return st.capturePromise;
  }
  function tick(s) {
    if (!s.saveOn || s.saveStopping || s.savePromise) return;
    if (s.spoolError) { void finish(s); return; }
    if (Date.now() < s.nextSaveAt) return;
    s.nextSaveAt = Date.now() + period(s);
    for (const st of s.students.values()) {
      Promise.resolve(capture(s, st)).then(result => {
        if (result === 'limit' && s.saveOn && !s.savePromise) {
          s.saveResult = '저장 메모리 또는 캡처 수 한도에 도달해 수집을 중지했습니다.';
          void finish(s);
        }
      });
    }
  }
  function finish(s) {
    if (s.savePromise) return s.savePromise;
    if (!s.saveOn && !s.saveBatch) return Promise.resolve(true);
    s.saveStopping = true;
    // Freeze the label before waiting for the last capture; retries keep the same filename/metadata.
    const lessonTitle = normalizeLessonTitle(s.lessonTitle);
    s.savePromise = Promise.resolve().then(async () => {
      if (s.saveOn) {
        await Promise.all([...s.students.values()].map(st => capture(s, st)));
        s.saveOn = false;
        await Promise.all(s.pendingWrites || []);
        const sp = s.saveStamp;
        s.saveBatch = [...s.students.values()].filter(st => st.frames.length).map(st => {
          const number = `${safe(st.grade, 4)}${pad(safe(st.cls, 6))}${pad(safe(st.num, 6))}`;
          const suffix = s.saveQuality === 'ai' ? '_AI고화질' : '';
          const classLabel = `${safe(st.grade, 4)}학년${safe(st.cls, 6)}반`;
          const prefix = [lessonFilenamePart(lessonTitle), classLabel].filter(Boolean).join('_');
          const filename = `${prefix}_${sp.date}_${sp.time}_${number}_${safe(st.name)}_${st.id}${suffix}.pdf`;
          const item = { frames: st.frames, file: path.join(dir, sp.date, safe(s.code), filename),
            title: [lessonTitle, classLabel, sp.date, `${st.num}번 ${st.name}`].filter(Boolean).join(' · '),
            subject: `수업명: ${lessonTitle || '미입력'}; 학급: ${classLabel}; 날짜: ${sp.date}; 수업 코드: ${s.code}`,
            keywords: [lessonTitle, classLabel, sp.date, '학생 화면 기록'].filter(Boolean) };
          st.frames = [];
          return item;
        });
        notify(s);
      }
      s.saveError = '';
      let saved = 0;
      for (const item of [...s.saveBatch]) {
        const temp = item.file + '.tmp';
        try {
          const pdf = await PDFDocument.create();
          pdf.setTitle(item.title);
          pdf.setSubject(item.subject);
          pdf.setKeywords(item.keywords);
          for (const frame of item.frames) {
            // pdf-lib requires an ArrayBuffer starting at offset zero.
            const bytes = frame instanceof Uint8Array ? frame :
              frame.bytes || Uint8Array.from(await fs.readFile(frame.file));
            const jpg = await pdf.embedJpg(bytes);
            const page = pdf.addPage([jpg.width, jpg.height]);
            page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
          }
          await fs.mkdir(path.dirname(item.file), { recursive: true });
          await fs.writeFile(temp, await pdf.save());
          await fs.rename(temp, item.file);
          for (const frame of item.frames) {
            if (frame instanceof Uint8Array) bufferedBytes -= frame.length;
            else {
              if (frame.bytes) bufferedBytes -= frame.bytes.length;
              await fs.unlink(frame.file).catch(() => {});
            }
          }
          s.saveBatch.splice(s.saveBatch.indexOf(item), 1);
          saved++;
          console.log(`[PDF 저장] ${path.basename(item.file)} (${item.frames.length}장)`);
        } catch (error) {
          await fs.unlink(temp).catch(() => {});
          console.error('[PDF 저장 오류]', error.message);
          s.saveError = 'PDF 저장 실패: 저장 경로와 디스크 공간을 확인한 뒤 재시도하세요. 화면 기록은 보관 중입니다.';
        }
      }
      if (!s.saveBatch.length) {
        s.saveBatch = null;
        await fs.rmdir(s.spoolDir).catch(() => {});
        s.saveResult = `${s.saveResult ? s.saveResult + ' ' : ''}PDF ${saved}개 저장 완료.`;
      }
      return !s.saveBatch;
    }).finally(() => { s.saveStopping = false; s.savePromise = null; notify(s); });
    notify(s);
    return s.savePromise;
  }
  return { info, start, tick, finish, capture };
}
module.exports = { createRecorder };
