export function clipboardPathKey(path: string) {
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(path)) {
    let value = path.replaceAll("/", "\\");
    if (value.startsWith("\\\\?\\UNC\\")) value = "\\\\" + value.slice(8);
    else if (value.startsWith("\\\\?\\")) value = value.slice(4);
    return value.toLowerCase().replace(/\\+$/, "");
  }
  return path;
}
