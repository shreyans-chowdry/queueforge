"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
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

interface JobData {
  id: string;
  status: string;
  priority: number;
  attempts: number;
  max_retries?: number;
  worker_id: string | null;
  created_at: string;
  payload?: Record<string, unknown>;
  error?: string | null;
}

interface WorkerData {
  last_seen: number;
  status: string;
  current_job_id: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL || API_BASE.replace(/^http/, "ws");

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
  const [mounted, setMounted] = useState<boolean>(false);
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [workers, setWorkers] = useState<Record<string, WorkerData>>({});
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [now, setNow] = useState<number>(0);
  const [flashingJobIds, setFlashingJobIds] = useState<Set<string>>(new Set());
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [activeTab, setActiveTab] = useState<
    "all" | "processing" | "pending" | "delayed" | "completed" | "dead_letter"
  >("all");

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [taskType, setTaskType] = useState<"sleep" | "compute" | "flaky">("sleep");
  const [taskPriority, setTaskPriority] = useState<number>(7);
  const [taskDelaySec, setTaskDelaySec] = useState<number>(0);
  const [sleepDuration, setSleepDuration] = useState<number>(1);
  const [computeIterations, setComputeIterations] = useState<number>(500000);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Live timer tick every 1s for accurate IST time & last-seen calculations
  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch initial jobs
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/jobs?limit=150`);
      if (res.ok) {
        const data = await res.json();
        setJobs(data);
      }
    } catch (err) {
      console.error("Failed to fetch jobs:", err);
    }
  }, []);

  // Poll workers registry every 2.5s
  const fetchWorkers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/workers`);
      if (res.ok) {
        const data = await res.json();
        setWorkers(data);
      }
    } catch (err) {
      console.error("Failed to fetch workers:", err);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    fetchWorkers();
    const interval = setInterval(fetchWorkers, 2500);
    return () => clearInterval(interval);
  }, [fetchJobs, fetchWorkers]);

  // Flash row helper
  const triggerRowFlash = useCallback((jobId: string) => {
    setFlashingJobIds((prev) => new Set(prev).add(jobId));
    setTimeout(() => {
      setFlashingJobIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }, 450);
  }, []);

  // WebSocket with instant in-memory patch
  useEffect(() => {
    let isMounted = true;

    const connectWs = () => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = new WebSocket(`${WS_BASE}/ws/jobs`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setWsConnected(true);
      };

      ws.onmessage = async (event) => {
        if (!isMounted) return;
        try {
          const payload = JSON.parse(event.data);
          const { job_id, status, worker_id, attempts, error } = payload;

          if (job_id) {
            triggerRowFlash(job_id);

            setJobs((prev) => {
              const idx = prev.findIndex((j) => j.id === job_id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = {
                  ...copy[idx],
                  status: status || copy[idx].status,
                  worker_id: worker_id !== undefined ? worker_id : copy[idx].worker_id,
                  attempts:
                    attempts !== undefined && attempts !== null
                      ? attempts
                      : copy[idx].attempts,
                  error: error !== undefined ? error : copy[idx].error,
                };
                return copy;
              }
              // If not found in memory, query this single new job
              fetch(`${API_BASE}/jobs/${job_id}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((newJob) => {
                  if (newJob && isMounted) {
                    setJobs((cur) => {
                      if (cur.some((item) => item.id === newJob.id)) return cur;
                      return [newJob, ...cur];
                    });
                  }
                })
                .catch(() => {});
              return prev;
            });
          }
        } catch (err) {
          console.error("WebSocket message parse error:", err);
        }
      };

      ws.onerror = () => {
        if (!isMounted) return;
        setWsConnected(false);
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setWsConnected(false);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMounted) connectWs();
        }, 3000);
      };
    };

    connectWs();

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [triggerRowFlash]);

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
    ([, w]) => w.status === "alive"
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
      const d = new Date(isoString.endsWith("Z") ? isoString : isoString + "Z");
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
  const handleCancelJob = async (jobId: string) => {
    setActionLoadingId(jobId);
    try {
      const res = await fetch(`${API_BASE}/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      if (res.ok) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? { ...j, status: "cancelled", error: "Cancelled by user" }
              : j
          )
        );
      }
    } catch (err) {
      console.error("Cancel failed:", err);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    setActionLoadingId(jobId);
    try {
      const res = await fetch(`${API_BASE}/jobs/${jobId}/retry`, {
        method: "POST",
      });
      if (res.ok) {
        const updated = await res.json();
        setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
      }
    } catch (err) {
      console.error("Retry failed:", err);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
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

      const res = await fetch(`${API_BASE}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload,
          priority: Number(taskPriority),
          execute_at,
        }),
      });

      if (res.ok) {
        const newJob = await res.json();
        setJobs((prev) => [newJob, ...prev]);
        setIsModalOpen(false);
      }
    } catch (err) {
      console.error("Submit task failed:", err);
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
      if (activeTab === "completed" && job.status !== "completed") return false;
      if (
        activeTab === "dead_letter" &&
        job.status !== "dead_letter" &&
        job.status !== "failed"
      )
        return false;

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesId = job.id.toLowerCase().includes(q);
        const matchesWorker = (job.worker_id || "").toLowerCase().includes(q);
        const matchesStatus = job.status.toLowerCase().includes(q);
        return matchesId || matchesWorker || matchesStatus;
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
                  // OPS CONTROL
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
              onClick={() => setIsModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-[#06B6D4] to-[#3B82F6] hover:from-[#0891B2] hover:to-[#2563EB] text-white text-xs font-semibold rounded-md shadow-md shadow-cyan-500/10 hover:shadow-cyan-500/20 transition-all cursor-pointer transform active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Enqueue Task</span>
            </button>
          </div>
        </div>
      </header>

      {/* Disconnect Alert */}
      {!wsConnected && (
        <div className="bg-rose-950/40 border-b border-rose-500/30 px-6 py-2">
          <div className="max-w-[1440px] mx-auto flex items-center justify-between text-xs font-mono">
            <span className="text-rose-400 flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              TELEMETRY STREAM OFFLINE // WebSocket stream to /ws/jobs disconnected. Reconnecting in 3s...
            </span>
            <span className="text-rose-400/70">RETRYING AUTOMATICALLY</span>
          </div>
        </div>
      )}

      {/* Main Mission Surface */}
      <main className="max-w-[1440px] mx-auto px-6 py-6 space-y-6">
        {/* Metric Cards - 4 Column Bento */}
        <section
          aria-label="Queue Metrics"
          className="grid grid-cols-2 lg:grid-cols-4 gap-3.5"
        >
          {/* Total Ingested */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg p-4 relative overflow-hidden group hover:border-[#2D374E] transition-colors">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono uppercase tracking-wider mb-2">
              <span>Total Ingested</span>
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
              Success Rate:{" "}
              <span className="text-slate-300 font-semibold">
                {totalJobs > 0
                  ? ((completedCount / totalJobs) * 100).toFixed(1)
                  : "100"}
                %
              </span>
            </div>
          </div>

          {/* Dead Letter / DLQ */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg p-4 relative overflow-hidden group hover:border-[#2D374E] transition-colors">
            <div className="flex items-center justify-between text-xs font-mono uppercase tracking-wider mb-2">
              <span className="text-rose-400 font-semibold">Dead Letter (DLQ)</span>
              <AlertOctagon className="w-4 h-4 text-rose-400" />
            </div>
            <div className="font-mono text-2xl font-bold text-rose-400 tracking-tight flex items-baseline gap-2">
              <span>{dlqCount}</span>
              <span className="text-xs text-slate-500 font-normal">failed</span>
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-1">
              Max retries exhausted
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
                [ NO REGISTERED WORKERS ] // No active worker containers detected in workers:registry.
              </div>
            ) : (
              workerEntries.map(([workerId, worker]) => {
                const isAlive = worker.status === "alive";
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
              ].map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
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
            <div className="relative min-w-[240px]">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by Job ID or Worker..."
                className="w-full pl-8 pr-3 py-1 bg-[#0C0E14] border border-[#1E2538] rounded text-xs text-slate-200 font-mono focus:outline-none focus:border-[#06B6D4] transition-colors placeholder:text-slate-600"
              />
            </div>
          </div>

          {/* Table Container */}
          <div className="bg-[#121624] border border-[#1E2538] rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
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
                      Attempts
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
                  {filteredJobs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-16 text-center text-slate-500 font-mono text-xs"
                      >
                        [ NO MATCHING JOBS ]
                        <div className="text-slate-600 text-[11px] mt-1">
                          No jobs found matching the current filter. Enqueue a task to begin.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredJobs.map((job) => {
                      const cfg = STATUS_CONFIG[job.status] || STATUS_CONFIG.pending;
                      const isFlashing = flashingJobIds.has(job.id);
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
                          tabIndex={0}
                          className={`hover:bg-[#181E30] transition-colors duration-150 ${
                            isFlashing ? "bg-cyan-500/15" : ""
                          }`}
                        >
                          {/* ID */}
                          <td className="px-4 py-2.5 text-slate-200 font-mono whitespace-nowrap">
                            <span className="text-slate-100 font-semibold" title={job.id}>
                              {job.id.slice(0, 8)}
                            </span>
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
                                onClick={() => handleCancelJob(job.id)}
                                disabled={isActionLoading}
                                className="text-[10px] px-2 py-0.5 rounded border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 cursor-pointer font-mono"
                              >
                                {isActionLoading ? "..." : "Cancel"}
                              </button>
                            )}
                            {canRetry && (
                              <button
                                onClick={() => handleRetryJob(job.id)}
                                disabled={isActionLoading}
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
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#121624] border border-[#1E2538] rounded-xl w-full max-w-md p-6 space-y-5 shadow-2xl shadow-black/80 animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[#1E2538] pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-md bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                  <Plus className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">Enqueue Background Task</h3>
                  <p className="text-[11px] text-slate-500 font-mono">
                    Dispatch workload into QueueForge engine
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-500 hover:text-slate-200 transition-colors p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateJob} className="space-y-4">
              {/* Task Type selector */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono uppercase text-slate-400 font-semibold">
                  Execution Payload Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setTaskType("sleep")}
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
        </div>
      )}
    </div>
  );
}
