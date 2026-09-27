// A short, optional lesson label. Keep user-facing words; sanitize only the filename.
function normalizeLessonTitle(value) {
  return typeof value === 'string' ? value.normalize('NFC')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim() : '';
}

function lessonFilenamePart(value) {
  return normalizeLessonTitle(value).replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_').replace(/^[. ]+|[. ]+$/g, '');
}

module.exports = { normalizeLessonTitle, lessonFilenamePart };
