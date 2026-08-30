// Converts a flat array of DB rows (each with uuid + row_key + original-cased
// fields) into the { [uuid]: {...fields} } shape the frontend expects (the
// same shape Firebase Realtime Database returned for a list node, just keyed
// by the row's real primary key instead of the Firebase key).
export function rowsToKeyedObject(rows) {
  const result = {};
  for (const row of rows) {
    const { uuid, row_key, ...fields } = row;
    result[uuid] = { uuid, ...fields };
  }
  return result;
}
