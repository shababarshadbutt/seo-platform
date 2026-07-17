"use client";

import { useEffect, useRef } from "react";
import { CheckCircle, XCircle, Loader2, ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type RunStatus = "idle" | "running" | "success" | "error";

interface TerminalOutputProps {
  lines: string[];
  status: RunStatus;
}

export function TerminalOutput({ lines, status }: TerminalOutputProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Scroll only the terminal body — never the page
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines]);

  function copyOutput() {
    navigator.clipboard.writeText(lines.join("\n"));
  }

  return (
    <div className="rounded-lg border overflow-hidden shadow-sm">
      {/* Terminal header bar */}
      <div className="flex items-center justify-between bg-gray-800 px-4 py-2">
        <div className="flex items-center gap-2 text-xs">
          {status === "idle" && (
            <span className="text-gray-500 font-medium">Terminal</span>
          )}
          {status === "running" && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-400" />
              <span className="text-yellow-400 font-medium">Running…</span>
            </>
          )}
          {status === "success" && (
            <>
              <CheckCircle className="h-3.5 w-3.5 text-green-400" />
              <span className="text-green-400 font-medium">Completed successfully</span>
            </>
          )}
          {status === "error" && (
            <>
              <XCircle className="h-3.5 w-3.5 text-red-400" />
              <span className="text-red-400 font-medium">Finished with errors</span>
            </>
          )}
        </div>
        {lines.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={copyOutput}
            className="h-6 px-2 text-xs text-gray-400 hover:text-gray-100"
          >
            <ClipboardCopy className="h-3 w-3 mr-1" />
            Copy
          </Button>
        )}
      </div>

      {/* Output body */}
      <div ref={bodyRef} className="bg-gray-950 px-4 py-3 font-mono text-xs text-gray-200 overflow-y-auto max-h-[480px] min-h-[200px]">
        {status === "idle" ? (
          <span className="text-gray-600">Run the script to see output here…</span>
        ) : lines.length === 0 ? (
          <span className="text-gray-600">Waiting for output…</span>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "leading-5",
                line.startsWith("[ERROR]") && "text-red-400",
                line.startsWith("[WARN]") && "text-yellow-400",
                line.startsWith("[DONE]") && "text-green-400",
                line.startsWith("[INFO]") && "text-gray-300"
              )}
            >
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
