export const MARSHAL_SPEC_FENCE = "marshal-spec";

export function extractMarshalSpec(text: string): string | null {
  const fence = "```";
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    const fenceMatch = trimmed.match(/^```(.*)$/);
    if (!fenceMatch) {
      i += 1;
      continue;
    }
    const info = fenceMatch[1].trim();
    if (info !== MARSHAL_SPEC_FENCE) {
      i += 1;
      continue;
    }
    const contentLines: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      const body = lines[j];
      const bodyTrim = body.trimStart();
      if (bodyTrim.startsWith(fence)) {
        closed = true;
        break;
      }
      contentLines.push(body);
      j += 1;
    }
    if (!closed) {
      i += 1;
      continue;
    }
    return contentLines.join("\n");
  }
  return null;
}
