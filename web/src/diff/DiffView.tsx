import { type DiffFile } from "./parseDiff";

interface Props {
  files: DiffFile[];
}

export function DiffView({ files }: Props) {
  if (files.length === 0) {
    return <p className="diff-empty">No changes.</p>;
  }
  return (
    <div className="diff">
      {files.map((file, fi) => (
        <section key={`${file.newPath}-${fi}`} className="diff-file">
          <header className="diff-file-header">{file.newPath}</header>
          <pre className="diff-body">
            {file.hunks.map((hunk, hi) => (
              <div key={hi} className="diff-hunk">
                <div className="diff-hunk-header">{`@@ -${hunk.oldStart},${hunk.oldLen} +${hunk.newStart},${hunk.newLen} @@`}</div>
                {hunk.lines.map((line, li) => (
                  <div key={li} className={`diff-line diff-line-${line.type}`}>
                    <span className="diff-line-marker">
                      {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                    </span>
                    <span className="diff-line-text">{line.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}