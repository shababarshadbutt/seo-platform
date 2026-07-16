import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default:
          "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-50",
        secondary:
          "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100",
        destructive:
          "border-red-200 bg-red-50 text-red-700 hover:bg-red-50",
        outline: "border-slate-200 bg-white text-slate-700",
        success:
          "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50",
        warning:
          "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-50",
        soft404:
          "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-50"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
