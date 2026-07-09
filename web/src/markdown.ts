import { marked } from "marked";

marked.setOptions({ async: false, gfm: true, breaks: false });

export function renderMarkdown(src: string): string {
  return marked.parse(src ?? "") as string;
}
