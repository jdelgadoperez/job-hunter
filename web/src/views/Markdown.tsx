import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Rendered markdown. react-markdown never renders raw HTML, so note content can't inject script. */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
