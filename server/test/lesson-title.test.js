const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { createRecorder } = require('../recording');
const { normalizeLessonTitle, lessonFilenamePart } = require('../lesson-title');

test('optional lesson labels are bounded and cannot introduce filename path separators', () => {
  assert.equal(normalizeLessonTitle(undefined), '');
  assert.equal(normalizeLessonTitle({ title: 'bad' }), '');
  assert.equal(normalizeLessonTitle(' \n 분수의  나눗셈\t '), '분수의 나눗셈');
  assert.equal(normalizeLessonTitle('수'.repeat(100)).length, 40);
  assert.equal(lessonFilenamePart(' ../비례식: 탐구? '), '-비례식-_탐구-');
  assert.equal(lessonFilenamePart('...'), '');
});

test('PDFs carry the latest lesson and each student class; blank titles and new segments work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-lesson-'));
  const jpeg = await fs.readFile(path.join(__dirname, 'capture.jpg'));
  const students = [2, 3].map((cls, index) => ({ id: index + 1, grade: '6', cls: String(cls),
    num: '7', name: '검증학생', ws: {}, frames: [], lastThumb: jpeg }));
  const s = { code: '123456', lessonTitle: '처음 제목', students: new Map(students.map(st => [st.id, st])) };
  const r = createRecorder({ dir, intervalMs: 30000, maxBytes: 1024 * 1024, notify() {} });
  r.start(s);
  s.lessonTitle = '분수의 나눗셈';
  const date = s.saveStamp.date;
  const output = path.join(dir, date, s.code);
  assert.equal(await r.finish(s), true);
  const files = await fs.readdir(output);
  assert.equal(files.length, 2);
  for (const cls of [2, 3]) {
    const file = files.find(name => name.startsWith(`분수의_나눗셈_6학년${cls}반_${date}_`));
    assert.ok(file, 'keyword and each student class precede the date');
    const pdf = await PDFDocument.load(await fs.readFile(path.join(output, file)));
    assert.equal(pdf.getPageCount(), 1);
    assert.match(pdf.getTitle(), /분수의 나눗셈/);
    assert.ok(pdf.getSubject().includes(`학급: 6학년${cls}반`));
    assert.ok(pdf.getKeywords().includes('분수의 나눗셈'));
  }
  s.lessonTitle = '';
  r.start(s);
  assert.equal(await r.finish(s), true);
  const after = await fs.readdir(output);
  assert.equal(after.length, 4, 'existing PDFs are neither renamed nor overwritten');
  assert.ok(after.some(file => file.startsWith(`6학년2반_${date}_`)));
});

test('failed PDF retry preserves the original title, output path and metadata', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-monitor-lesson-retry-'));
  const dir = path.join(parent, 'blocked');
  await fs.writeFile(dir, 'test fixture blocks directory creation');
  const st = { id: 1, grade: '6', cls: '2', num: '1', name: '검증학생', ws: {}, frames: [],
    lastThumb: await fs.readFile(path.join(__dirname, 'capture.jpg')) };
  const s = { code: '123456', lessonTitle: '비례식', students: new Map([[1, st]]) };
  const r = createRecorder({ dir, intervalMs: 30000, maxBytes: 1024 * 1024, notify() {} });
  r.start(s);
  assert.equal(await r.finish(s), false);
  const originalFile = s.saveBatch[0].file;
  s.lessonTitle = '다른 수업';
  await fs.unlink(dir); // Only remove the file created above, never a directory.
  assert.equal(await r.finish(s), true);
  const pdf = await PDFDocument.load(await fs.readFile(originalFile));
  assert.ok(path.basename(originalFile).startsWith('비례식_6학년2반_'));
  assert.match(pdf.getTitle(), /비례식/);
  assert.doesNotMatch(pdf.getTitle(), /다른 수업/);
});
