"use client";

import { useEffect, useState, useMemo } from "react";
import {
  Plus,
  RotateCw,
  X,
  Moon,
  Cpu,
  Zap,
  Search,
  Activity,
  Layers,
  Clock,
  Radio,
  CheckCircle,
  AlertOctagon,
  RefreshCw,
} from "lucide-react";

import { JOB_LIMIT, JobData, request, useQueue } from "@/lib/queue";
import { Modal } from "@/components/modal";

const STATUS_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; border: string; dot: string }
> = {
  pending: {
    label: "pending",
    bg: "bg-slate-500/10",
    text: "text-slate-400",
    border: "border-slate-500/20",
    dot: "bg-slate-400",
  },
  delayed: {
    label: "delayed",
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/20",
    dot: "bg-amber-400",
  },
  processing: {
    label: "processing",
    bg: "bg-cyan-500/10",
    text: "text-cyan-400",
    border: "border-cyan-500/30",
    dot: "bg-cyan-400 animate-ping",
  },
  completed: {
    label: "completed",
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  failed: {
    label: "failed",
    bg: "bg-rose-500/10",
    text: "text-rose-400",
    border: "border-rose-500/20",
    dot: "bg-rose-400",
  },
  dead_letter: {
    label: "dead letter",
    bg: "bg-red-500/15",
    text: "text-red-400",
    border: "border-red-500/30",
    dot: "bg-red-500",
  },
  cancelled: {
    label: "cancelled",
    bg: "bg-neutral-800",
    text: "text-neutral-400",
    border: "border-neutral-700",
    dot: "bg-neutral-500",
  },
};

export default function OpsConsole() {
  const { jobs, workers, wsConnected, loading, error, updatedAt, refresh } = useQueue();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const selectedJob = jobs.find((job) => job.id === selectedJobId);

  const [now, setNow] = useState<number>(0);
  const mounted = now > 0;
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeTab, setActiveTab] = useState<
    "all" | "processing" | "pending" | "delayed" | "completed" | "dead_letter" | "cancelled"
  >("all");

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [taskType, setTaskType] = useState<"sleep" | "compute" | "flaky">("sleep");
  const [taskPriority, setTaskPriority] = useState<number>(7);
  const [taskDelaySec, setTaskDelaySec] = useState<number>(0);
  const [sleepDuration, setSleepDuration] = useState<number>(1);
  const [computeIterations, setComputeIterations] = useState<number>(500000);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Derived metrics
  const totalJobs = jobs.length;
  const processingCount = jobs.filter((j) => j.status === "processing").length;
  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const dlqCount = jobs.filter(
    (j) => j.status === "dead_letter" || j.status === "failed"
  ).length;
  const pendingCount = jobs.filter((j) => j.status === "pending").length;
  const delayedCount = jobs.filter((j) => j.status === "delayed").length;

  const workerEntries = Object.entries(workers);
  const activeWorkersCount = workerEntries.filter(
    ([, w]) => w.status === "alive" && (!now || now - w.last_seen < 15000)
  ).length;

  // IST Time Formatter (Indian Standard Time, Asia/Kolkata)
  const formatISTClock = (epochMs: number) => {
    if (!epochMs) return "--:--:--";
    return new Date(epochMs).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const formatISTDate = (epochMs: number) => {
    if (!epochMs) return "";
    return new Date(epochMs).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
    });
  };

  const formatRelativeSeconds = (epochMs: number) => {
    if (!mounted || !epochMs || !now) return "—";
    const diffSec = Math.max(0, Math.floor((now - epochMs) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    return `${diffMin}m ${diffSec % 60}s ago`;
  };

  const formatTimestamp = (isoString: string) => {
    if (!mounted || !isoString) return "—";
    try {
      const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(isoString) ? isoString : isoString + "Z");
      return d.toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return isoString;
    }
  };

  // Actions
  const handleJobAction = async (jobId: string, action: "cancel" | "retry") => {
    if (actionLoadingId) return;
    setActionLoadingId(jobId);
    setActionError(null);
    setNotice(null);
    try {
      await request(`/jobs/${jobId}/${action}`, { method: "POST" });
      setNotice(action === "cancel" ? "Job cancelled." : "Job requeued with a fresh retry budget.");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Action failed. Please retry.");
    } finally {
      refresh();
      setActionLoadingId(null);
    }
  };

  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    try {
      let payload: Record<string, unknown> = { type: taskType };
      if (taskType === "sleep") {
        payload = { type: "sleep", seconds: Number(sleepDuration) };
      } else if (taskType === "compute") {
        payload = { type: "compute", iterations: Number(computeIterations) };
      } else {
        payload = { type: "flaky" };
      }

      let execute_at: string | null = null;
      if (taskDelaySec > 0) {
        execute_at = new Date(Date.now() + taskDelaySec * 1000).toISOString();
      }

      await request<JobData>("/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, priority: Number(taskPriority), execute_at }),
      });
      setNotice("Task dispatched successfully.");
      setIsModalOpen(false);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to dispatch the task.");
    } finally {
      setSubmitting(false);
    }
  };

  // Filtered jobs list
  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      // Tab filter
      if (activeTab === "processing" && job.status !== "processing") return false;
      if (activeTab === "pending" && job.status !== "pending") return false;
      if (activeTab === "delayed" && job.status !== "delayed") return false;
      if (activeTab === "cancelled" && job.status !== "cancelled") return false;
      if (activeTab === "completed" && job.status !== "completed") return false;
      if (
        activeTab === "dead_letter" &&
        job.status !== "dead_letter" &&
        job.status !== "failed"
      )
        return false;

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesId = job.id.toLowerCase().includes(q);
        const matchesWorker = (job.worker_id || "").toLowerCase().includes(q);
        const matchesStatus = job.status.toLowerCase().includes(q);
        return matchesId || matchesWorker || matchesStatus || JSON.stringify(job.payload).toLowerCase().includes(q);
      }

      return true;
    });
  }, [jobs, activeTab, searchQuery]);

  return (
    <div className="min-h-screen bg-[#0C0E14] text-[#E2E8F0] font-sans antialiased selection:bg-[#06B6D4]/20 selection:text-white">
      {/* Flight Control Top Bar */}
      <header className="border-b border-[#1E2538] bg-[#0F121C]/90 backdrop-blur-md px-6 py-3 sticky top-0 z-30 shadow-lg shadow-black/20">
        <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Brand & Connection Status */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-[#161B2A] border border-[#232B40]">
              <span className="relative flex h-2 w-2">
                {wsConnected && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#10B981] opacity-75" />
                )}
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${
                    wsConnected ? "bg-[#10B981]" : "bg-[#EF4444]"
                  }`}
                />
              </span>
              <span className="font-mono text-[11px] font-semibold tracking-wider uppercase text-slate-300">
                {wsConnected ? "STREAM LIVE" : "DISCONNECTED"}
              </span>
            </div>

            <div className="h-4 w-px bg-[#232B40]" />

            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-wider uppercase text-white flex items-center gap-1.5">
                <span className="text-[#06B6D4]">QUEUEFORGE</span>
                <span className="text-slate-500 text-xs font-normal">
                  Ops control
                </span>
              </span>
            </div>
          </div>

          {/* Right Action Bar */}
          <div className="flex items-center gap-4">
            {/* Live IST Clock */}
            <div
              className="font-mono text-xs text-slate-300 bg-[#161B2A] px-3 py-1.5 rounded border border-[#232B40] flex items-center gap-2"
              suppressHydrationWarning
            >
              <Clock className="w-3.5 h-3.5 text-[#06B6D4]" />
              <span className="font-semibold text-white">
                {mounted && now ? formatISTClock(now) : "--:--:--"}
              </span>
              <span className="text-[10px] text-slate-500 font-medium">
                {mounted && now ? formatISTDate(now) : "IST"}
              </span>
            </div>

            {/* Primary Action Button */}
            <button
              onClick={() => { setActionError(null); setIsModalOpen(true); }}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-[#06B6D4] to-[#3B82F6] hover:from-[#0891B2] hover:to-[#2563EB] text-white text-xs font-semibold rounded-md shadow-md shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-all cursor-pointer transform active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Enqueue Task</span>
            </button>
          </div>
        </div>
      </header>

      {/* Disconnect Alert */}
      {!wsConnected && !loading && (
        <div className="bg-rose-950/40 border-b border-rose-500/30 px-6 py-2">
          <div className="max-w-[1440px] mx-auto flex items-center justify-between text-xs font-mono">
            <span className="text-rose-400 flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              Live stream reconnecting. Jobs and workers refresh every 5 seconds.
            </span>
            <span className="text-rose-400/70">RETRYING AUTOMATICALLY</span>
          </div>
        </div>
      )}

      {/* Main Mission Surface */}
      <main className="w-full max-w-[1440px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-400 mb-2">QueueForge / Overview</p>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">Queue operations</h1>
            <p className="mt-2 text-sm text-slate-400">Dispatch work, monitor your fleet, and recover failed tasks.</p>
          </div>
          <button onClick={refresh} className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">
            <RotateCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-300">Could not refresh the console: {error}. {updatedAt ? "Showing the last successful snapshot." : "Check that the API is running."}</div>}
        {actionError && !isModalOpen && <p role="alert" className="rounded-lg border border-rose-500/30 p-3 text-sm text-rose-300">{actionError}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-300">{notice}</p>}
        <p className="text-xs text-slate-400">Metrics cover the latest {JOB_LIMIT} jobs. {updatedAt ? `Last synced ${formatISTClock(updatedAt)} IST.` : "Connecting to the API…"}</p>
        {/* Metric Cards - 4 Column Bento */}
        <section
          aria-label="Queue Metrics"
          className="grid grid-cols-2 lg:grid-cols-4 gap-3.5"
        >
          {/* Recent jobs */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg p-4 relative overflow-hidden group hover:border-[#2D374E] transition-colors">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono uppercase tracking-wider mb-2">
              <span>Recent jobs</span>
              <Layers className="w-4 h-4 text-slate-500" />
            </div>
            <div className="font-mono text-2xl font-bold text-white tracking-tight">
              {totalJobs.toLocaleString()}
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-1 flex items-center gap-1.5">
              <span>Delayed: {delayedCount}</span>
              <span>•</span>
              <span>Pending: {pendingCount}</span>
            </div>
          </div>

          {/* Active In-Flight */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg p-4 relative overflow-hidden group hover:border-[#2D374E] transition-colors">
            <div className="flex items-center justify-between text-xs font-mono uppercase tracking-wider mb-2">
              <span className="text-cyan-400 font-semibold">Active In-Flight</span>
              <Activity className="w-4 h-4 text-cyan-400 animate-pulse" />
            </div>
            <div className="font-mono text-2xl font-bold text-cyan-400 tracking-tight flex items-baseline gap-2">
              <span>{processingCount}</span>
              <span className="text-xs text-slate-500 font-normal">tasks</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1">
              Active Workers:{" "}
              <span className="text-cyan-400 font-semibold">
                {activeWorkersCount}/{workerEntries.length}
              </span>
            </div>
          </div>

          {/* Completed */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg p-4 relative overflow-hidden group hover:border-[#2D374E] transition-colors">
            <div className="flex items-center justify-between text-xs font-mono uppercase tracking-wider mb-2">
              <span className="text-emerald-400 font-semibold">Processed / Success</span>
              <CheckCircle className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="font-mono text-2xl font-bold text-emerald-400 tracking-tight">
              {completedCount.toLocaleString()}
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-1">
              Completion share:{" "}
              <span className="text-slate-300 font-semibold">
                {totalJobs > 0
                  ? ((completedCount / totalJobs) * 100).toFixed(1)
                  : "0"}
                %
              </span>
            </div>
          </div>

          {/* Dead Letter / DLQ */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg p-4 relative overflow-hidden group hover:border-[#2D374E] transition-colors">
            <div className="flex items-center justify-between text-xs font-mono uppercase tracking-wider mb-2">
              <span className="text-rose-400 font-semibold">Needs attention</span>
              <AlertOctagon className="w-4 h-4 text-rose-400" />
            </div>
            <div className="font-mono text-2xl font-bold text-rose-400 tracking-tight flex items-baseline gap-2">
              <span>{dlqCount}</span>
              <span className="text-xs text-slate-500 font-normal">failed</span>
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-1">
              Dead-lettered or failed to enqueue
            </div>
          </div>
        </section>

        {/* Worker Fleet Matrix */}
        <section aria-label="Worker Fleet" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <Radio className="w-3.5 h-3.5 text-[#06B6D4]" />
              <span>Distributed Worker Fleet</span>
            </h2>
            <span className="text-[11px] font-mono text-slate-500">
              Heartbeat: 5s • Auto-reap: 15s
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {workerEntries.length === 0 ? (
              <div className="col-span-full bg-[#121624] border border-[#1E2538] rounded-lg p-6 text-center font-mono text-xs text-slate-500">
                No workers connected. Start a worker to begin processing jobs.
              </div>
            ) : (
              workerEntries.map(([workerId, worker]) => {
                const isAlive = worker.status === "alive" && (!now || now - worker.last_seen < 15000);
                const isBusy = Boolean(worker.current_job_id);

                return (
                  <div
                    key={workerId}
                    className={`bg-[#121624] border rounded-lg p-3.5 space-y-2.5 transition-colors ${
                      isAlive ? "border-[#1E2538] hover:border-[#2E374E]" : "border-rose-900/30 bg-rose-950/10"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isAlive ? (isBusy ? "bg-cyan-400 animate-pulse" : "bg-emerald-400") : "bg-rose-500"
                          }`}
                        />
                        <span
                          className="font-mono text-xs font-medium text-slate-200 truncate"
                          title={workerId}
                        >
                          {workerId}
                        </span>
                      </div>

                      <span
                        className={`font-mono text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${
                          isAlive
                            ? isBusy
                              ? "bg-cyan-500/15 text-cyan-300"
                              : "bg-emerald-500/15 text-emerald-300"
                            : "bg-rose-500/15 text-rose-300"
                        }`}
                      >
                        {isAlive ? (isBusy ? "BUSY" : "IDLE") : "OFFLINE"}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-[#1E2538]/70 flex items-center justify-between text-xs font-mono text-slate-400">
                      <span>
                        Last Heartbeat:{" "}
                        <span className="text-slate-300">
                          {formatRelativeSeconds(worker.last_seen)}
                        </span>
                      </span>

                      <span>
                        {worker.current_job_id ? (
                          <span className="text-cyan-400 font-medium">
                            {worker.current_job_id.slice(0, 8)}...
                          </span>
                        ) : (
                          <span className="text-slate-500">Ready</span>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Telemetry Job Stream Table */}
        <section aria-label="Job Table" className="space-y-3">
          {/* Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[#121624] border border-[#1E2538] p-2.5 rounded-lg">
            {/* Filter Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto">
              {[
                { key: "all", label: "All Tasks", count: totalJobs },
                { key: "processing", label: "In-Flight", count: processingCount },
                { key: "pending", label: "Pending", count: pendingCount },
                { key: "delayed", label: "Delayed", count: delayedCount },
                { key: "completed", label: "Completed", count: completedCount },
                { key: "dead_letter", label: "DLQ / Failed", count: dlqCount },
                { key: "cancelled", label: "Cancelled", count: jobs.filter((job) => job.status === "cancelled").length },
              ].map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    aria-pressed={isActive}
                    onClick={() => setActiveTab(tab.key as typeof activeTab)}
                    className={`px-3 py-1 rounded text-xs font-mono transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      isActive
                        ? "bg-[#1E2538] text-white font-semibold"
                        : "text-slate-400 hover:text-slate-200 hover:bg-[#161B2A]"
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                        isActive ? "bg-cyan-500/20 text-cyan-300" : "bg-[#1A2030] text-slate-500"
                      }`}
                    >
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-auto sm:min-w-[240px]">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search jobs by ID, worker, status, or payload"
                placeholder="Search jobs or payload…"
                className="w-full pl-8 pr-3 py-1 bg-[#0C0E14] border border-[#1E2538] rounded text-xs text-slate-200 font-mono focus:outline-none focus:border-[#06B6D4] transition-colors placeholder:text-slate-600"
              />
            </div>
          </div>

          {/* Table Container */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <caption className="sr-only">Latest jobs with status, priority, failed attempts, assigned worker, and actions</caption>
                <thead className="sticky top-0 bg-[#0F121C] border-b border-[#1E2538] z-10 text-[11px] font-mono uppercase tracking-wider text-slate-400">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 whitespace-nowrap">
                      Job ID
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right">
                      Priority
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right">
                      Failures
                    </th>
                    <th scope="col" className="px-4 py-2.5 whitespace-nowrap">
                      Worker ID
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right whitespace-nowrap">
                      Created (IST)
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-center whitespace-nowrap">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2538]/60 text-xs font-mono">
                  {loading ? <tr><td colSpan={7} className="p-10 text-center text-sm text-slate-400">Loading queue activity…</td></tr> : filteredJobs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-16 text-center text-slate-500 font-mono text-xs"
                      >
                        {jobs.length ? "No jobs match these filters. Try another status or search." : error ? "Waiting for the API to reconnect." : "Your queue is clear. Enqueue a task to get started."}
                        <div className="text-slate-600 text-[11px] mt-1">
                          No jobs found matching the current filter. Enqueue a task to begin.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredJobs.map((job) => {
                      const cfg = STATUS_CONFIG[job.status] || STATUS_CONFIG.pending;

                      const isActionLoading = actionLoadingId === job.id;

                      const canCancel =
                        job.status === "pending" || job.status === "delayed";
                      const canRetry =
                        job.status === "dead_letter" ||
                        job.status === "failed" ||
                        job.status === "cancelled";

                      return (
                        <tr
                          key={job.id}
                          className="hover:bg-[#181E30] transition-colors duration-150"
                        >
                          {/* ID */}
                          <td className="px-4 py-2.5 text-slate-200 font-mono whitespace-nowrap">
                            <button onClick={() => setSelectedJobId(job.id)} className="text-cyan-300 font-semibold underline decoration-cyan-800 underline-offset-4" aria-label={`Inspect job ${job.id}`} title={job.id}>
                              {job.id.slice(0, 8)}
                            </button>
                            <span className="text-slate-600">{job.id.slice(8, 14)}...</span>
                          </td>

                          {/* Status Badge */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] uppercase font-bold tracking-wider ${cfg.bg} ${cfg.text} ${cfg.border}`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                              <span>{cfg.label}</span>
                            </span>
                          </td>

                          {/* Priority */}
                          <td className="px-4 py-2.5 text-right font-mono">
                            <span
                              className={`font-semibold ${
                                job.priority >= 8
                                  ? "text-rose-400"
                                  : job.priority >= 5
                                  ? "text-slate-200"
                                  : "text-slate-500"
                              }`}
                            >
                              {job.priority}
                            </span>
                          </td>

                          {/* Attempts */}
                          <td className="px-4 py-2.5 text-right text-slate-400 font-mono">
                            <span
                              className={
                                job.attempts > 0 ? "text-amber-400 font-semibold" : "text-slate-400"
                              }
                            >
                              {job.attempts}
                            </span>
                            <span className="text-slate-600">
                              /{job.max_retries ?? 3}
                            </span>
                          </td>

                          {/* Worker ID */}
                          <td
                            className="px-4 py-2.5 text-slate-400 whitespace-nowrap font-mono truncate max-w-[180px]"
                            title={job.worker_id || "Unassigned"}
                          >
                            {job.worker_id ? (
                              <span className="text-slate-300">{job.worker_id}</span>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>

                          {/* Created Time in IST */}
                          <td className="px-4 py-2.5 text-right text-slate-400 whitespace-nowrap font-mono">
                            {formatTimestamp(job.created_at)}
                          </td>

                          {/* Action */}
                          <td className="px-4 py-2.5 text-center whitespace-nowrap">
                            {canCancel && (
                              <button
                                onClick={() => handleJobAction(job.id, "cancel")}
                                disabled={actionLoadingId !== null}
                                className="text-[10px] px-2 py-0.5 rounded border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 cursor-pointer font-mono"
                              >
                                {isActionLoading ? "..." : "Cancel"}
                              </button>
                            )}
                            {canRetry && (
                              <button
                                onClick={() => handleJobAction(job.id, "retry")}
                                disabled={actionLoadingId !== null}
                                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-50 cursor-pointer font-mono font-medium"
                              >
                                <RefreshCw className="w-2.5 h-2.5" />
                                <span>{isActionLoading ? "..." : "Re-drive"}</span>
                              </button>
                            )}
                            {job.status === "completed" && (
                              <span className="text-emerald-400 text-[10px] font-medium">✓ Done</span>
                            )}
                            {job.status === "processing" && (
                              <span className="text-cyan-400 text-[10px] animate-pulse font-medium">
                                Running
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      {/* Interactive Enqueue Task Modal */}
      {isModalOpen && (
        <Modal onClose={() => setIsModalOpen(false)} labelledBy="enqueue-title">
          <div className="bg-[#121624] border border-[#1E2538] rounded-xl w-full p-6 space-y-5 shadow-2xl shadow-black/80 animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[#1E2538] pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-md bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                  <Plus className="w-4 h-4" />
                </div>
                <div>
                  <h3 id="enqueue-title" className="font-bold text-sm text-white">Enqueue Background Task</h3>
                  <p className="text-[11px] text-slate-500 font-mono">
                    Dispatch workload into QueueForge engine
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                aria-label="Close enqueue dialog"
                className="text-slate-500 hover:text-slate-200 transition-colors p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateJob} className="space-y-4">
              {actionError && <p role="alert" className="text-sm text-rose-300">{actionError}</p>}
              {/* Task Type selector */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono uppercase text-slate-400 font-semibold">
                  Execution Payload Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setTaskType("sleep")}
                    aria-pressed={taskType === "sleep"}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                      taskType === "sleep"
                        ? "border-[#06B6D4] bg-cyan-500/15 text-cyan-300 font-bold shadow-sm shadow-cyan-500/20"
                        : "border-[#1E2538] text-slate-400 hover:border-[#2E374E]"
                    }`}
                  >
                    <Moon className="w-4 h-4 mb-1" />
                    <span>Sleep (I/O)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTaskType("compute")}
                    aria-pressed={taskType === "compute"}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                      taskType === "compute"
                        ? "border-[#06B6D4] bg-cyan-500/15 text-cyan-300 font-bold shadow-sm shadow-cyan-500/20"
                        : "border-[#1E2538] text-slate-400 hover:border-[#2E374E]"
                    }`}
                  >
                    <Cpu className="w-4 h-4 mb-1" />
                    <span>Compute</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTaskType("flaky")}
                    aria-pressed={taskType === "flaky"}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                      taskType === "flaky"
                        ? "border-rose-500 bg-rose-500/15 text-rose-300 font-bold shadow-sm shadow-rose-500/20"
                        : "border-[#1E2538] text-slate-400 hover:border-[#2E374E]"
                    }`}
                  >
                    <Zap className="w-4 h-4 mb-1" />
                    <span>Flaky Retry</span>
                  </button>
                </div>
              </div>

              {/* Dynamic Parameter Settings */}
              {taskType === "sleep" && (
                <div className="space-y-1 bg-[#0C0E14] p-3 rounded-lg border border-[#1E2538]">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-slate-400">Sleep Duration</span>
                    <span className="text-cyan-400 font-bold">{sleepDuration}s</span>
                  </div>
                  <input
                    type="range"
                    aria-label="Sleep duration in seconds"
                    min="0.5"
                    max="10"
                    step="0.5"
                    value={sleepDuration}
                    onChange={(e) => setSleepDuration(Number(e.target.value))}
                    className="w-full accent-[#06B6D4]"
                  />
                </div>
              )}

              {taskType === "compute" && (
                <div className="space-y-1 bg-[#0C0E14] p-3 rounded-lg border border-[#1E2538]">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-slate-400">SHA-256 Iterations</span>
                    <span className="text-cyan-400 font-bold">
                      {computeIterations.toLocaleString()}
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Compute iterations"
                    min="100000"
                    max="1500000"
                    step="100000"
                    value={computeIterations}
                    onChange={(e) => setComputeIterations(Number(e.target.value))}
                    className="w-full accent-[#06B6D4]"
                  />
                </div>
              )}

              {taskType === "flaky" && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 font-mono">
                  ~30% chance of failure to exercise exponential backoff and the Dead-Letter Queue.
                </div>
              )}

              {/* Priority Selector */}
              <div className="space-y-1 bg-[#0C0E14] p-3 rounded-lg border border-[#1E2538]">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-400">Priority Level</span>
                  <span
                    className={`font-bold ${
                      taskPriority >= 8
                        ? "text-rose-400"
                        : taskPriority >= 5
                        ? "text-cyan-400"
                        : "text-slate-400"
                    }`}
                  >
                    Tier {taskPriority} ({taskPriority >= 8 ? "URGENT" : taskPriority >= 5 ? "NORMAL" : "LOW"})
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Job priority"
                  min="1"
                  max="10"
                  value={taskPriority}
                  onChange={(e) => setTaskPriority(Number(e.target.value))}
                  className="w-full accent-[#06B6D4]"
                />
                <div className="flex justify-between text-[10px] font-mono text-slate-500">
                  <span>1 (Lowest)</span>
                  <span>5 (Standard)</span>
                  <span>10 (Emergency)</span>
                </div>
              </div>

              {/* Schedule Delay Selector */}
              <div className="space-y-1 bg-[#0C0E14] p-3 rounded-lg border border-[#1E2538]">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-400">Execution Schedule</span>
                  <span className="text-amber-400 font-bold">
                    {taskDelaySec === 0 ? "Immediate Dispatch" : `Delayed by +${taskDelaySec}s`}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Schedule delay in seconds"
                  min="0"
                  max="30"
                  step="5"
                  value={taskDelaySec}
                  onChange={(e) => setTaskDelaySec(Number(e.target.value))}
                  className="w-full accent-[#F59E0B]"
                />
                {taskDelaySec > 0 && mounted && now && (
                  <p className="text-[10px] font-mono text-amber-400/80 mt-1">
                    Will trigger at ~{formatISTClock(now + taskDelaySec * 1000)} IST
                  </p>
                )}
              </div>

              {/* Submit Buttons */}
              <div className="pt-2 flex items-center justify-end gap-2 border-t border-[#1E2538]">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-md border border-[#1E2538] text-xs font-mono text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-[#06B6D4] to-[#3B82F6] hover:from-[#0891B2] hover:to-[#2563EB] text-white text-xs font-semibold rounded-md shadow-md transition-all cursor-pointer disabled:opacity-50"
                >
                  {submitting ? "Dispatching..." : "Dispatch Task"}
                </button>
              </div>
            </form>
          </div>
        </Modal>
      )}
      {selectedJob && <Modal labelledBy="job-title" onClose={() => setSelectedJobId(null)}>
        <div className="p-6 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="job-title" className="text-lg font-semibold text-white">Job details</h2>
            <button aria-label="Close job details" onClick={() => setSelectedJobId(null)} className="p-2 hover:bg-slate-800 rounded"><X className="h-4 w-4" /></button>
          </div>
          <p className="break-all font-mono text-xs text-cyan-300">{selectedJob.id}</p>
          <dl className="grid grid-cols-2 gap-4 text-xs">
            {Object.entries({ Status: selectedJob.status, Priority: selectedJob.priority, Failures: `${selectedJob.attempts}/${selectedJob.max_retries}`, Worker: selectedJob.worker_id || "Unassigned", Created: formatTimestamp(selectedJob.created_at), Scheduled: selectedJob.scheduled_at ? formatTimestamp(selectedJob.scheduled_at) : "Immediate", Started: selectedJob.started_at ? formatTimestamp(selectedJob.started_at) : "—", Finished: selectedJob.completed_at ? formatTimestamp(selectedJob.completed_at) : "—" }).map(([label, value]) => <div key={label}><dt className="text-slate-400 mb-1">{label}</dt><dd className="break-all">{value}</dd></div>)}
          </dl>
          {selectedJob.error && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300 break-words">{selectedJob.error}</div>}
          <div><h3 className="text-xs font-semibold text-slate-400 mb-2">Payload</h3><pre className="overflow-auto rounded-lg bg-[#0C0E14] p-4 text-xs text-slate-300">{JSON.stringify(selectedJob.payload, null, 2)}</pre></div>
          {selectedJob.result && <div><h3 className="text-xs font-semibold text-slate-400 mb-2">Result</h3><pre className="overflow-auto rounded-lg bg-[#0C0E14] p-4 text-xs">{JSON.stringify(selectedJob.result, null, 2)}</pre></div>}
          <p className="text-xs text-slate-500">All times are shown in IST.</p>
        </div>
      </Modal>}
    </div>
  );
}
