// Compare the values the server will store while preserving the user's text.
const comparable = (value) => typeof value === "string" ? value.trim() : value;

export function mergeEditorFields(baseline, local, remote) {
  const values = {};
  const conflicts = [];
  for (const key of Object.keys(baseline)) {
    const ours = comparable(local[key]);
    const theirs = comparable(remote[key]);
    const original = comparable(baseline[key]);
    if (ours === original) values[key] = remote[key];
    else {
      values[key] = local[key];
      if (theirs !== original && ours !== theirs) conflicts.push({ key, local: local[key], remote: remote[key] });
    }
  }
  return { values, conflicts };
}
