import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { client } from "../lib/rpc";
import { cn } from "../lib/cn";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href?.startsWith("https://")) void client.app.openExternal({ url: href });
              }}
            >
              {c}
            </a>
          ),
          code: ({ className: cls, children: c, ...rest }) => {
            // GitHub suggestion blocks: show them as a proposed change.
            if (cls?.includes("language-suggestion")) {
              return (
                <span className="block">
                  <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-ok">Suggested change</span>
                  <code className={cls} {...rest}>
                    {c}
                  </code>
                </span>
              );
            }
            return (
              <code className={cls} {...rest}>
                {c}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
