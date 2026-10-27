export function matchesMask(name: string, mask: string) {
  const expression = Array.from(mask)
    .map((c) =>
      c === "*"
        ? ".*"
        : c === "?"
          ? "."
          : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${expression}$`, "iu").test(name);
}
