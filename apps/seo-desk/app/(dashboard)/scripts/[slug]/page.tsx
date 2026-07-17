import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getScriptBySlug } from "@/lib/scripts-config";
import { ScriptRunner } from "@/components/script-runner";

interface Props {
  params: { slug: string };
}

export default function ScriptExecutionPage({ params }: Props) {
  const script = getScriptBySlug(params.slug);
  if (!script) notFound();

  const Icon = script.icon;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href="/scripts"
          className="mt-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Scripts
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-2xl font-bold">{script.name}</h2>
          <p className="text-sm text-muted-foreground">{script.description}</p>
        </div>
      </div>

      {/* Form + terminal */}
      <ScriptRunner slug={params.slug} />
    </div>
  );
}
