import ReactMarkdown,{defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';
function reviewUrl(url:string){try{const value=new URL(url,'https://hub.invalid/');return ['https:','http:'].includes(value.protocol)&&!value.username&&!value.password?url:'';}catch{return '';}}
export function Markdown({ content, safeLinksOnly = false, gfm = false }: {
  content: string;
  safeLinksOnly?: boolean;
  gfm?: boolean;
}) {
  return <div className="markdown min-w-0 break-words">
    <ReactMarkdown skipHtml remarkPlugins={gfm ? [remarkGfm] : undefined}
      urlTransform={safeLinksOnly ? reviewUrl : defaultUrlTransform}
      components={{
        img: ({ alt }) => <span className="text-sm text-slate-500">{alt}</span>,
        a: ({ children, ...props }) => {
          delete props.node;
          return props.href ? <a {...props} rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
        },
        table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
      }}>{content}</ReactMarkdown>
  </div>;
}
