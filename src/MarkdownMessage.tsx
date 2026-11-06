import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
const plugins = [remarkGfm];
const components = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 对话中的远程图片只显示说明，避免在阅读模型回复时自动发起外部请求。
  img: ({ alt }: { alt?: string }) => (
    <span className="markdown-image">{alt ? `图片：${alt}` : "图片"}</span>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
};
export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <Markdown remarkPlugins={plugins} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
