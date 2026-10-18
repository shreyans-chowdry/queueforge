"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface JobData {
  id: string;
  status: string;
  priority: number;
  attempts: number;
  max_retries: number;
  worker_id: string | null;
  created_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
}

interface WorkerData {
  last_seen: number;
  status: string;
  current_job_id: string | null;
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const WS_BASE = (process.env.NEXT_PUBLIC_WS_URL || API_BASE.replace(/^http/, "ws")).replace(/\/$/, "");
export const JOB_LIMIT = 150;

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options, cache: "no-store", signal: options?.signal ?? AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((item: { msg: string }) => item.msg).join("; ")
      : detail?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function useQueue() {
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [workers, setWorkers] = useState<Record<string, WorkerData>>({});
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const schedule = useRef<() => void>(() => {});
  const refresh = useCallback(() => schedule.current(), []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let batch: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let dirty = false;
    const controller = new AbortController();

    const load = async () => {
      if (disposed) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
        const [nextJobs, nextWorkers] = await Promise.all([
          request<JobData[]>(`/jobs?limit=${JOB_LIMIT}`, { signal }),
          request<Record<string, WorkerData>>("/workers", { signal }),
        ]);
        if (!disposed) {
          setJobs(nextJobs);
          setWorkers(nextWorkers);
          setUpdatedAt(Date.now());
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Unable to reach the API");
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          if (dirty) { dirty = false; scheduleLoad(); }
        }
      }
    };

    // Coalesce event bursts; never perform fetches from React state updaters.
    const scheduleLoad = () => {
      if (!disposed && !batch) batch = setTimeout(() => { batch = undefined; void load(); }, 250);
    };
    schedule.current = scheduleLoad;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${WS_BASE}/ws/jobs`);
      socket.onopen = () => { if (!disposed) { setWsConnected(true); scheduleLoad(); } };
      socket.onmessage = scheduleLoad;
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!disposed) { setWsConnected(false); reconnect = setTimeout(connect, 3000); }
      };
    };
    void load();
    connect();
    // Redis Pub/Sub is not durable. Poll even with a live socket to reconcile gaps.
    const interval = setInterval(scheduleLoad, 5000);
    window.addEventListener("online", scheduleLoad);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(batch);
      clearTimeout(reconnect);
      clearInterval(interval);
      socket?.close();
      window.removeEventListener("online", scheduleLoad);
      schedule.current = () => {};
    };
  }, []);

  return { jobs, workers, wsConnected, loading, error, updatedAt, refresh };
}
