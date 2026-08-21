"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Server, Activity, CheckCircle, XCircle, Clock } from "lucide-react";

interface JobData {
  id: string;
  status: string;
  priority: number;
  attempts: number;
  worker_id: string | null;
  created_at: string;
}

interface WorkerData {
  last_seen: number;
  status: string;
  current_job_id: string | null;
}

const API_BASE = "http://127.0.0.1:8000";
const WS_BASE = "ws://127.0.0.1:8000";

export default function Dashboard() {
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [workers, setWorkers] = useState<Record<string, WorkerData>>({});

  useEffect(() => {
    fetch(`${API_BASE}/jobs`)
      .then((res) => res.json())
      .then((data) => setJobs(data))
      .catch(console.error);
  }, []);

  useEffect(() => {
    const fetchWorkers = () => {
      fetch(`${API_BASE}/workers`)
        .then((res) => res.json())
        .then((data) => setWorkers(data))
        .catch(console.error);
    };
    fetchWorkers();
    const interval = setInterval(fetchWorkers, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws/jobs`);
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      const { job_id } = data;

      try {
        const res = await fetch(`${API_BASE}/jobs/${job_id}`);
        if (res.ok) {
          const updatedJob = await res.json();
          setJobs((prev) => {
            const exists = prev.find((j) => j.id === job_id);
            if (exists) {
              return prev.map((j) => (j.id === job_id ? updatedJob : j));
            }
            return [updatedJob, ...prev];
          });
        }
      } catch (err) {
        console.error(err);
      }
    };
    return () => ws.close();
  }, []);

  const totalJobs = jobs.length;
  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const failedCount = jobs.filter((j) => j.status === "dead_letter").length;
  const processingCount = jobs.filter((j) => j.status === "processing").length;

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      pending: "bg-slate-500/20 text-slate-400 border-slate-500/30",
      processing: "bg-blue-500/20 text-blue-400 border-blue-500/30",
      completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
      failed: "bg-rose-500/20 text-rose-400 border-rose-500/30",
      dead_letter: "bg-rose-500/20 text-rose-400 border-rose-500/30",
      delayed: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    };
    const style = styles[status] || styles.pending;
    return (
      <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border tracking-wide uppercase ${style}`}>
        {status.replace("_", " ")}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-6 md:p-12 font-sans selection:bg-blue-500/30">
      <div className="max-w-7xl mx-auto space-y-10">
        
        <header className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-800/60 pb-8 gap-4">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-br from-blue-400 via-indigo-400 to-emerald-400 bg-clip-text text-transparent flex items-center gap-4">
              <div className="p-3 bg-slate-900 rounded-2xl border border-slate-800/60 shadow-lg shadow-blue-900/20">
                <Activity className="w-8 h-8 text-blue-400" />
              </div>
              QueueForge Dashboard
            </h1>
            <p className="text-slate-400 mt-3 text-lg font-medium">Real-time distributed job processing monitor</p>
          </div>
          <div className="flex items-center gap-3 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span className="text-emerald-400 font-semibold text-sm tracking-wide uppercase">System Online</span>
          </div>
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard title="Total Jobs" value={totalJobs} icon={<Server className="w-6 h-6 text-slate-400"/>} />
          <StatCard title="Processing" value={processingCount} icon={<Activity className="w-6 h-6 text-blue-400"/>} />
          <StatCard title="Completed" value={completedCount} icon={<CheckCircle className="w-6 h-6 text-emerald-400"/>} />
          <StatCard title="Dead Letter" value={failedCount} icon={<XCircle className="w-6 h-6 text-rose-400"/>} />
        </section>

        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-3">
              <Server className="w-6 h-6 text-indigo-400" /> Active Workers
            </h2>
            <span className="text-sm font-medium text-slate-500 bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
              {Object.keys(workers).length} Registered
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Object.keys(workers).length === 0 && (
              <div className="col-span-full py-8 text-center border border-dashed border-slate-700/50 rounded-2xl bg-slate-900/30 text-slate-500">
                No workers currently registered. Start a worker process.
              </div>
            )}
            {Object.entries(workers).map(([id, w]) => {
              const isAlive = w.status === "alive";
              return (
                <div key={id} className="bg-slate-900/60 rounded-2xl p-6 border border-slate-800/80 hover:border-indigo-500/50 hover:bg-slate-800/80 transition-all duration-300 shadow-lg shadow-black/20 group relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-4 opacity-50 group-hover:opacity-100 transition-opacity">
                     <span className="relative flex h-3 w-3">
                        {isAlive && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50"></span>}
                        <span className={`relative inline-flex rounded-full h-3 w-3 ${isAlive ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                      </span>
                  </div>
                  <div className="flex flex-col gap-4">
                    <div>
                      <div className="text-xs font-bold tracking-wider text-slate-500 uppercase mb-1">Worker ID</div>
                      <div className="font-mono text-sm text-slate-200 break-all">{id}</div>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-400 font-medium">
                      <Clock className="w-4 h-4 text-slate-500" />
                      Last seen {formatDistanceToNow(new Date(w.last_seen))} ago
                    </div>
                    {w.current_job_id && (
                       <div className="mt-2 pt-4 border-t border-slate-800/60">
                         <div className="text-xs font-bold tracking-wider text-indigo-400 uppercase mb-1 flex items-center gap-2">
                           <Activity className="w-3 h-3 animate-pulse" /> Processing Job
                         </div>
                         <div className="font-mono text-xs text-slate-400 truncate">{w.current_job_id}</div>
                       </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-3">
              <Activity className="w-6 h-6 text-emerald-400" /> Recent Jobs
            </h2>
          </div>
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800/80 shadow-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-950/50 text-slate-400 uppercase font-bold text-xs tracking-widest border-b border-slate-800/80">
                  <tr>
                    <th className="px-6 py-5 whitespace-nowrap">Job ID</th>
                    <th className="px-6 py-5">Status</th>
                    <th className="px-6 py-5">Priority</th>
                    <th className="px-6 py-5">Attempts</th>
                    <th className="px-6 py-5 whitespace-nowrap">Worker ID</th>
                    <th className="px-6 py-5 whitespace-nowrap">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {jobs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500 font-medium">
                        No jobs found. Submit some jobs via the API.
                      </td>
                    </tr>
                  )}
                  {jobs.slice(0, 100).map((job) => (
                    <tr key={job.id} className="hover:bg-slate-800/50 transition-colors group">
                      <td className="px-6 py-4 font-mono text-xs text-slate-300 group-hover:text-indigo-300 transition-colors">{job.id}</td>
                      <td className="px-6 py-4">{getStatusBadge(job.status)}</td>
                      <td className="px-6 py-4">
                        <span className="bg-slate-800 px-2.5 py-1 rounded-md text-slate-300 font-mono text-xs border border-slate-700">{job.priority}</span>
                      </td>
                      <td className="px-6 py-4 text-slate-400 font-mono text-xs">
                        <span className={job.attempts > 0 ? "text-amber-400" : ""}>{job.attempts}</span> / {job.max_retries || 3}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-500 group-hover:text-slate-300 transition-colors">
                        {job.worker_id || "—"}
                      </td>
                      <td className="px-6 py-4 text-slate-400 font-medium whitespace-nowrap text-xs">
                        {new Date(job.created_at + "Z").toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string, value: number, icon: React.ReactNode }) {
  return (
    <div className="bg-slate-900/60 p-6 rounded-2xl border border-slate-800/80 flex items-center justify-between hover:border-indigo-500/50 hover:bg-slate-800/80 transition-all duration-300 shadow-lg shadow-black/20 group relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      <div className="relative z-10">
        <div className="text-slate-400 text-sm font-bold tracking-wide uppercase mb-2">{title}</div>
        <div className="text-4xl font-black text-white tracking-tight">{value}</div>
      </div>
      <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/60 shadow-inner relative z-10 group-hover:scale-110 group-hover:text-indigo-400 transition-all duration-300">
        {icon}
      </div>
    </div>
  );
}
