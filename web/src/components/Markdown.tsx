import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 不启用 raw HTML：原始标签按文本处理，危险协议由默认 urlTransform 剥离。 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          table: ({ node: _node, ...props }) => <div className="table-scroll"><table {...props} /></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
