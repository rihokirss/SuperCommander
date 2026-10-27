export function indentEdit(
  text: string,
  start: number,
  end: number,
  outdent: boolean,
) {
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const newline = text.indexOf("\n", last);
  const to = newline < 0 ? text.length : newline;
  const lines = text.slice(from, to).split("\n");
  const changed = lines.map((line) =>
    outdent ? line.replace(/^(?:\t| {1,4})/, "") : "\t" + line,
  );
  const first = changed[0].length - lines[0].length;
  const total = changed.reduce(
    (sum, line, index) => sum + line.length - lines[index].length,
    0,
  );
  const selectionStart = Math.max(from, start + first);
  return {
    from,
    to,
    text: changed.join("\n"),
    selectionStart,
    selectionEnd: Math.max(selectionStart, end + total),
  };
}
