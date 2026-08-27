// Converts a flat array of DB rows (each with row_key + original-cased fields)
// into the { [row_key]: {...fields} } shape the frontend expects (this is the
// same shape Firebase Realtime Database returned for a list node).
export function rowsToKeyedObject(rows) {
  const result = {};
  for (const row of rows) {
    const { row_key, ...fields } = row;
    result[row_key] = fields;
  }
  return result;
}
