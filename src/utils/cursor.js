export function encodeCursor(doc) {
  return Buffer.from(JSON.stringify({ t: doc.observedAt || doc.createdAt, id: doc._id })).toString('base64url');
}
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return null; }
}
