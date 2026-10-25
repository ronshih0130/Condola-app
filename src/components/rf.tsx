import React, { type ReactNode } from "react";

export function RfTable({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <table className="t rf" data-testid={testId}>
      {children}
    </table>
  );
}

export function Cell({
  label,
  children,
  className,
  action,
}: {
  label?: string;
  children?: ReactNode;
  className?: string;
  action?: boolean;
}) {
  if (action) {
    return <td className={className ? `r ${className}` : "r"}>{children}</td>;
  }
  return (
    <td className={className} data-label={label ?? ""}>
      <span className="v">{children}</span>
    </td>
  );
}
