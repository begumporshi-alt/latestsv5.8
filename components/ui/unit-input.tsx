import * as React from "react";

import { cn } from "@/lib/utils";

interface UnitInputProps extends React.ComponentProps<"input"> {
  unit?: string;
  prefix?: string;
}

export function UnitInput({ unit, prefix, className, ...props }: UnitInputProps) {
  return (
    <div className="relative inline-flex w-full items-center">
      {prefix ? (
        <span className="pointer-events-none absolute left-2.5 text-sm text-muted-foreground select-none">
          {prefix}
        </span>
      ) : null}
      <input
        type="number"
        inputMode="decimal"
        {...props}
        className={cn(
          "w-full border border-border rounded bg-transparent px-2 py-1 text-sm tabular-nums text-right focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50",
          prefix && "pl-7",
          unit && "pr-7",
          className
        )}
      />
      {unit ? (
        <span className="pointer-events-none absolute right-2 text-sm text-muted-foreground select-none">
          {unit}
        </span>
      ) : null}
    </div>
  );
}
