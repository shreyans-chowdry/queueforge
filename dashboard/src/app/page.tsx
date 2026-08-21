"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface JobData {
  id: string;
  status: string;
  priority: number;
  attempts: number;
  max_retries?: number;
  worker_id: string | null;
  created_at: string;
  payload?: Record<string, unknown>;
}

interface WorkerData {
  last_seen: number;
  status: string;
  current_job_id: string | null;
}

const API_BASE = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";

const STATUS_CONFIG: Record<
  string,
  { label: string; dotColor: string; textColor: string }
> = {
  pending: {
    label: "pending",
    dotColor: "#8B92A3",
    textColor: "#8B92A3",
  },
  delayed: {
    label: "delayed",
    dotColor: "#D9A441",
    textColor: "#D9A441",
  },
  processing: {
    label: "processing",
    dotColor: "#4C8DFF",
    textColor: "#4C8DFF",
  },
  completed: {
    label: "completed",
    dotColor: "#3ECF8E",
    textColor: "#3ECF8E",
  },
  failed: {
    label: "failed",
    dotColor: "#E5484D",
    textColor: "#E5484D",
  },
  dead_letter: {
    label: "dead_letter",
    dotColor: "#E5484D",
    textColor: "#E5484D",
  },
};

export default function OpsConsole() {
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [workers, setWorkers] = useState<Record<string, WorkerData>>({});
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [flashingJobIds, setFlashingJobIds] = useState<Set<string>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Live timer tick every 1s for accurate "last seen Xs ago"
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch initial jobs
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/jobs?limit=100`);
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
    }, 400);
  }, []);

  // WebSocket with auto-reconnect
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
        setWsError(null);
      };

      ws.onmessage = async (event) => {
        if (!isMounted) return;
        try {
          const payload = JSON.parse(event.data);
          const { job_id } = payload;

          if (job_id) {
            triggerRowFlash(job_id);

            // Fetch specific job or update state
            const res = await fetch(`${API_BASE}/jobs/${job_id}`);
            if (res.ok) {
              const updatedJob: JobData = await res.json();
              setJobs((prev) => {
                const idx = prev.findIndex((j) => j.id === job_id);
                if (idx >= 0) {
                  const copy = [...prev];
                  copy[idx] = updatedJob;
                  return copy;
                }
                return [updatedJob, ...prev];
              });
            }
          }
        } catch (err) {
          console.error("WebSocket message parse error:", err);
        }
      };

      ws.onerror = () => {
        if (!isMounted) return;
        setWsConnected(false);
        setWsError("Stream disconnected. Target: ws://127.0.0.1:8000/ws/jobs");
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setWsConnected(false);
        // Reconnect after 3 seconds
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
  const failedCount = jobs.filter(
    (j) => j.status === "dead_letter" || j.status === "failed"
  ).length;

  const workerEntries = Object.entries(workers);

  const formatRelativeSeconds = (epochMs: number) => {
    if (!epochMs) return "—";
    const diffSec = Math.max(0, Math.floor((now - epochMs) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    return `${diffMin}m ${diffSec % 60}s ago`;
  };

  const formatTimestamp = (isoString: string) => {
    try {
      const d = new Date(isoString.endsWith("Z") ? isoString : isoString + "Z");
      return d.toLocaleTimeString("en-GB", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="min-h-screen bg-[#14171C] text-[#E4E6EB] text-sm antialiased selection:bg-[#4C8DFF]/20">
      {/* Top Console Bar */}
      <header className="border-b border-[#2A2F3A] bg-[#14171C] px-6 py-3 sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* System / WS status indicator */}
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                {wsConnected && (
                  <span
                    className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                    style={{ backgroundColor: "#3ECF8E" }}
                  />
                )}
                <span
                  className="relative inline-flex rounded-full h-2 w-2"
                  style={{
                    backgroundColor: wsConnected ? "#3ECF8E" : "#E5484D",
                  }}
                />
              </span>
              <span className="font-mono text-xs tracking-wider uppercase text-[#8B92A3]">
                {wsConnected ? "LIVE" : "DISCONNECTED"}
              </span>
            </div>

            <span className="text-[#2A2F3A]">/</span>

            <h1 className="font-semibold tracking-wide text-xs uppercase text-[#E4E6EB]">
              QueueForge Ops Console
            </h1>

            <span className="text-[#2A2F3A] hidden sm:inline">/</span>
            <span className="text-[#8B92A3] text-xs font-mono hidden sm:inline">
              127.0.0.1:8000
            </span>
          </div>

          <div className="flex items-center gap-6 font-mono text-xs text-[#8B92A3]">
            <span>
              WORKERS:{" "}
              <strong className="text-[#E4E6EB] font-mono">
                {workerEntries.length}
              </strong>
            </span>
            <span>
              STREAM:{" "}
              <span
                className="font-mono font-medium"
                style={{ color: wsConnected ? "#3ECF8E" : "#E5484D" }}
              >
                {wsConnected ? "CONNECTED" : "OFFLINE"}
              </span>
            </span>
            <span className="text-[#8B92A3]">
              UTC {new Date(now).toISOString().slice(11, 19)}
            </span>
          </div>
        </div>
      </header>

      {/* Disconnected Alert Banner */}
      {!wsConnected && (
        <div className="bg-[#1C2028] border-b border-[#E5484D]/40 px-6 py-2">
          <div className="max-w-[1400px] mx-auto flex items-center justify-between text-xs font-mono">
            <span className="text-[#E5484D] flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#E5484D]" />
              STREAM OFFLINE // Real-time WebSocket connection to /ws/jobs lost.
              Reconnecting automatically...
            </span>
            <span className="text-[#8B92A3]">RETRYING IN 3S</span>
          </div>
        </div>
      )}

      {/* Main Content Surface */}
      <main className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
        {/* Section 1: Slim Summary Stats Row */}
        <section
          aria-label="Queue Metrics"
          className="bg-[#1C2028] border border-[#2A2F3A] rounded-md grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-[#2A2F3A]"
        >
          <div className="px-5 py-3.5">
            <div className="font-mono text-xl font-medium tracking-tight text-[#E4E6EB]">
              {totalJobs}
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-[#8B92A3] mt-0.5">
              Total Enqueued
            </div>
          </div>

          <div className="px-5 py-3.5">
            <div
              className="font-mono text-xl font-medium tracking-tight"
              style={{ color: processingCount > 0 ? "#4C8DFF" : "#E4E6EB" }}
            >
              {processingCount}
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-[#8B92A3] mt-0.5">
              Processing
            </div>
          </div>

          <div className="px-5 py-3.5">
            <div
              className="font-mono text-xl font-medium tracking-tight"
              style={{ color: completedCount > 0 ? "#3ECF8E" : "#E4E6EB" }}
            >
              {completedCount}
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-[#8B92A3] mt-0.5">
              Completed
            </div>
          </div>

          <div className="px-5 py-3.5">
            <div
              className="font-mono text-xl font-medium tracking-tight"
              style={{ color: failedCount > 0 ? "#E5484D" : "#E4E6EB" }}
            >
              {failedCount}
            </div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-[#8B92A3] mt-0.5">
              Dead Letter / Failed
            </div>
          </div>
        </section>

        {/* Section 2: Worker Health Cluster */}
        <section aria-label="Worker Health Cluster" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8B92A3]">
              Worker Fleet Registry
            </h2>
            <span className="text-[11px] font-mono text-[#8B92A3]">
              HEARTBEAT INTERVAL: 5S
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {workerEntries.length === 0 ? (
              <div className="col-span-full bg-[#1C2028] border border-[#2A2F3A] rounded-md px-5 py-6 text-center font-mono text-xs text-[#8B92A3]">
                [ NO REGISTERED WORKERS ] // No active worker processes detected
                in Redis registry (workers:registry).
              </div>
            ) : (
              workerEntries.map(([workerId, worker]) => {
                const isAlive = worker.status === "alive";
                const dotColor = isAlive ? "#3ECF8E" : "#E5484D";
                const statusLabel = isAlive ? "ALIVE" : "DEAD";

                return (
                  <div
                    key={workerId}
                    tabIndex={0}
                    className="bg-[#1C2028] border border-[#2A2F3A] rounded-md p-3.5 space-y-2.5 hover:border-[#3B4252] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4C8DFF] transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div
                        className="font-mono text-xs font-medium text-[#E4E6EB] truncate"
                        title={workerId}
                      >
                        {workerId}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ backgroundColor: dotColor }}
                        />
                        <span
                          className="font-mono text-[11px] font-medium uppercase tracking-wider"
                          style={{ color: dotColor }}
                        >
                          {statusLabel}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#2A2F3A]/70 flex items-center justify-between text-xs font-mono text-[#8B92A3]">
                      <span>
                        LAST SEEN:{" "}
                        <span className="text-[#E4E6EB]">
                          {formatRelativeSeconds(worker.last_seen)}
                        </span>
                      </span>
                      <span>
                        {worker.current_job_id ? (
                          <span className="text-[#4C8DFF]">
                            JOB: {worker.current_job_id.slice(0, 8)}...
                          </span>
                        ) : (
                          <span className="text-[#8B92A3]">IDLE</span>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Section 3: Dense Telemetry Job Table */}
        <section aria-label="Job Table" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8B92A3]">
              Enqueued & Historical Jobs
            </h2>
            <div className="flex items-center gap-3 font-mono text-[11px] text-[#8B92A3]">
              <span>BUFFER: {jobs.length} ROWS</span>
            </div>
          </div>

          <div className="bg-[#1C2028] border border-[#2A2F3A] rounded-md overflow-hidden">
            <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[#1C2028] border-b border-[#2A2F3A] z-10 text-[11px] font-semibold tracking-wider uppercase text-[#8B92A3]">
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
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2A2F3A]/60 text-xs font-mono">
                  {jobs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-12 text-center text-[#8B92A3] font-mono text-xs"
                      >
                        [ NO ACTIVE OR HISTORICAL JOBS ]
                        <div className="text-[#8B92A3]/70 text-[11px] mt-1">
                          Cluster queue is empty. Submit tasks via POST /jobs to
                          observe real-time orchestration.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    jobs.map((job) => {
                      const cfg =
                        STATUS_CONFIG[job.status] || STATUS_CONFIG.pending;
                      const isFlashing = flashingJobIds.has(job.id);

                      return (
                        <tr
                          key={job.id}
                          tabIndex={0}
                          className={`hover:bg-[#252B36] focus-visible:bg-[#252B36] focus-visible:outline-none transition-colors duration-150 ${
                            isFlashing ? "animate-row-flash" : ""
                          }`}
                        >
                          {/* ID */}
                          <td className="px-4 py-2 text-[#E4E6EB] whitespace-nowrap font-mono">
                            {job.id}
                          </td>

                          {/* Status: Small colored dot + label */}
                          <td className="px-4 py-2 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ backgroundColor: cfg.dotColor }}
                              />
                              <span
                                className="font-mono text-[11px] tracking-wide uppercase font-medium"
                                style={{ color: cfg.textColor }}
                              >
                                {cfg.label}
                              </span>
                            </span>
                          </td>

                          {/* Priority (Right-aligned numeric) */}
                          <td className="px-4 py-2 text-right text-[#E4E6EB] font-mono">
                            {job.priority}
                          </td>

                          {/* Attempts (Right-aligned numeric) */}
                          <td className="px-4 py-2 text-right text-[#8B92A3] font-mono">
                            <span
                              className={
                                job.attempts > 0 ? "text-[#D9A441]" : "text-[#8B92A3]"
                              }
                            >
                              {job.attempts}
                            </span>
                            <span className="text-[#8B92A3]/60">
                              /{job.max_retries ?? 3}
                            </span>
                          </td>

                          {/* Worker ID */}
                          <td
                            className="px-4 py-2 text-[#8B92A3] whitespace-nowrap font-mono truncate max-w-[200px]"
                            title={job.worker_id || "unassigned"}
                          >
                            {job.worker_id ? (
                              <span className="text-[#E4E6EB]">
                                {job.worker_id}
                              </span>
                            ) : (
                              <span className="text-[#8B92A3]/50">—</span>
                            )}
                          </td>

                          {/* Created (Right-aligned monospace timestamp) */}
                          <td className="px-4 py-2 text-right text-[#8B92A3] whitespace-nowrap font-mono">
                            {formatTimestamp(job.created_at)}
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
    </div>
  );
}
