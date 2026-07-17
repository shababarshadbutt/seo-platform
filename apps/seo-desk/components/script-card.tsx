import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { type ScriptConfig } from "@/lib/scripts-config";
import { Button } from "@/components/ui/button";

interface ScriptCardProps {
  script: ScriptConfig;
}

export function ScriptCard({ script }: ScriptCardProps) {
  const Icon = script.icon;

  return (
    <div className="group flex flex-col rounded-xl border bg-card p-5 shadow-sm transition-all duration-300 ease-out hover:shadow-xl hover:shadow-black/8 hover:-translate-y-1 hover:scale-[1.02]">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-sm leading-snug">{script.name}</h3>
          {script.outputLabel && (
            <p className="text-xs text-muted-foreground mt-0.5">
              → {script.outputLabel}
            </p>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground flex-1 mb-4">
        {script.description}
      </p>

      {/* Inputs summary */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {script.inputs.map((input) => (
          <span
            key={input.name}
            className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
          >
            {input.label}
            {input.required && (
              <span className="ml-1 text-destructive font-bold">*</span>
            )}
          </span>
        ))}
      </div>

      {/* Action */}
      <Button asChild size="sm" className="w-full">
        <Link href={`/scripts/${script.slug}`}>
          Run script
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}
