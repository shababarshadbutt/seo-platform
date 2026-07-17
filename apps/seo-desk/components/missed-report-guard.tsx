"use client";

import { useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { CalendarDays, Loader2, PlaneTakeoff, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function MissedReportGuard() {
  const { data: session, status } = useSession();
  const [missedDate, setMissedDate]   = useState<string | null>(null);
  const [checked,    setChecked]      = useState(false);
  const [mode,       setMode]         = useState<"choose" | "report">("choose");
  const [reportText, setReportText]   = useState("");
  const [loading,    setLoading]      = useState(false);
  const [error,      setError]        = useState("");

  async function checkMissed() {
    try {
      const res = await fetch("/api/daily-reports/missed-check");
      const data = await res.json();
      setMissedDate(data.missedDate ?? null);
    } catch {
      setMissedDate(null);
    }
    setMode("choose");
    setReportText("");
    setError("");
    setLoading(false);
  }

  useEffect(() => {
    if (status !== "authenticated") return;
    if (session?.user?.role === "super-admin") { setChecked(true); return; }

    fetch("/api/daily-reports/missed-check")
      .then((r) => r.json())
      .then((data) => { setMissedDate(data.missedDate ?? null); setChecked(true); })
      .catch(() => setChecked(true));
  }, [status, session]);

  const open = checked && missedDate !== null;

  const formattedDate = missedDate
    ? new Date(missedDate + "T12:00:00Z").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      })
    : "";

  async function submitReport() {
    if (!reportText.trim()) { setError("Report cannot be empty."); return; }
    setError(""); setLoading(true);
    const res = await fetch("/api/daily-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: missedDate, report: reportText, type: "report" }),
    });
    if (!res.ok) { setLoading(false); setError((await res.json()).error ?? "Something went wrong."); return; }
    await checkMissed();
  }

  async function markLeave() {
    setError(""); setLoading(true);
    const res = await fetch("/api/daily-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: missedDate, type: "leave" }),
    });
    if (!res.ok) { setLoading(false); setError("Something went wrong. Please try again."); return; }
    await checkMissed();
  }

  async function markHoliday() {
    setError(""); setLoading(true);
    const res = await fetch("/api/daily-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: missedDate, type: "public-holiday" }),
    });
    if (!res.ok) { setLoading(false); const d = await res.json().catch(() => ({})); setError(d.error ?? "Something went wrong. Please try again."); return; }
    await checkMissed();
  }

  if (!open) return null;

  return (
    <Dialog open={true} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-lg max-h-[90vh] overflow-y-auto [&>button.absolute]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-orange-600">
            <CalendarDays className="h-5 w-5" />
            Missing Daily Report
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          You did not submit a daily report for{" "}
          <span className="font-semibold text-foreground">{formattedDate}</span>.
          Please submit your report or mark the day as leave before continuing.
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {mode === "choose" ? (
          <div className="flex flex-col gap-2 pt-1">
            <Button onClick={() => setMode("report")} className="w-full">
              Submit Report for this day
            </Button>
            <Button variant="outline" className="w-full" onClick={markLeave} disabled={loading}>
              {loading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <PlaneTakeoff className="h-4 w-4" />
              }
              I was on leave
            </Button>
            <Button variant="outline" className="w-full" onClick={markHoliday} disabled={loading}>
              {loading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <PartyPopper className="h-4 w-4" />
              }
              Public Holiday
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Textarea
              placeholder={"- Added 3 backlinks for client A\n- Completed landing page request\n- Reviewed blog topics..."}
              className="text-sm leading-relaxed"
              style={{ minHeight: "180px" }}
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => { setMode("choose"); setError(""); }} disabled={loading}>
                Back
              </Button>
              <Button onClick={submitReport} disabled={loading || !reportText.trim()}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Submit Report
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
