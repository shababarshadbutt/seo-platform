import { scripts } from "@/lib/scripts-config";
import { ScriptCard } from "@/components/script-card";

export default function ScriptsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Scripts</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {scripts.length} scripts available. Click <strong>Run script</strong> to open the execution form.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {scripts.map((script) => (
          <ScriptCard key={script.slug} script={script} />
        ))}
      </div>
    </div>
  );
}
