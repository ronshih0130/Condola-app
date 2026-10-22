import React, { Fragment, type ReactNode } from "react";
import { fullNoticeBlocks, type NoticeBlock, type NoticeInline, type NoticeListItem, type NoticeVars } from "./id-notice";

function Inlines({ items }: { items: NoticeInline[] }) {
  return items.map((item, index) =>
    item.kind === "strong" ? <strong key={index}>{item.text}</strong> : <Fragment key={index}>{item.text}</Fragment>,
  );
}

function Items({ items, ordered }: { items: NoticeListItem[]; ordered: boolean }) {
  const List = ordered ? "ol" : "ul";
  return (
    <List>
      {items.map((item, index) => (
        <li key={index}>
          {index > 0 ? "\n" : null}
          <Inlines items={item.inlines} />
          {item.children.length ? (
            <>
              {"\n"}
              <Items items={item.children} ordered={false} />
            </>
          ) : null}
        </li>
      ))}
    </List>
  );
}

function BlockView({ block }: { block: NoticeBlock }) {
  if (block.kind === "hr") return <hr />;
  if (block.kind === "h") {
    const Heading = block.level === 3 ? "h3" : "h4";
    return (
      <Heading>
        <Inlines items={block.inlines} />
      </Heading>
    );
  }
  if (block.kind === "p") {
    return (
      <p>
        <Inlines items={block.inlines} />
      </p>
    );
  }
  return <Items items={block.items} ordered={block.kind === "ol"} />;
}

/** Formatted statutory notice. Text content is fullNoticeText. */
export function FullNotice({ vars }: { vars: NoticeVars }) {
  const parts: ReactNode[] = [];
  let started = false;
  fullNoticeBlocks(vars).forEach((block, index) => {
    if (block.kind === "hr") {
      parts.push(<hr key={index} />);
      return;
    }
    if (started) parts.push(<Fragment key={`n-${index}`}>{"\n"}</Fragment>);
    started = true;
    parts.push(<BlockView key={index} block={block} />);
  });
  return (
    <div className="id-notice" data-testid="idv-notice-full">
      {parts}
    </div>
  );
}
