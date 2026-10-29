'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { MonitoringSnapshot, SystemLog } from '@/lib/monitoring';

function formatCount(value: number | null): string {
  return value === null ? 'Not available' : new Intl.NumberFormat().format(value);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

export default function AdminPage() {
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function refresh(): Promise<void> {
      try {
        const response = await fetch('/api/admin/metrics', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Metrics endpoint returned ${response.status}.`);
        const nextSnapshot = (await response.json()) as MonitoringSnapshot;
        if (active) {
          setSnapshot(nextSnapshot);
          setError('');
        }
      } catch (refreshError: unknown) {
        if (active) {
          setError(
            refreshError instanceof Error ? refreshError.message : 'Could not load system metrics.',
          );
        }
      }
    }

    void refresh();
    const interval = setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const logs: SystemLog[] = snapshot?.logs ?? [];

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <Link className="back-link" href="/">
            ← Back to chat
          </Link>
          <p className="eyebrow">OPERATIONS</p>
          <h1>System monitoring</h1>
          <p className="admin-subtitle">
            Live, process-local telemetry · refreshes every 5 seconds
          </p>
        </div>
        <span className="live-indicator">
          <span /> LIVE
        </span>
      </header>

      {error && <p className="inline-error">{error}</p>}
      {!snapshot && !error && <p className="loading-copy">Loading system metrics…</p>}
      {snapshot && (
        <>
          <section aria-label="Rate limiting status" className="metrics-grid">
            <article className="metric-card">
              <p className="metric-label">Application requests remaining</p>
              <p className="metric-value">
                {formatCount(snapshot.rateLimit.remaining)}
                <span> / {formatCount(snapshot.rateLimit.limit)}</span>
              </p>
              <div className="progress-track">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      (snapshot.rateLimit.used / Math.max(snapshot.rateLimit.limit, 1)) * 100,
                    )}%`,
                  }}
                />
              </div>
              <p className="metric-caption">
                Resets in {formatDuration(snapshot.rateLimit.resetInMs)} ·{' '}
                {formatTime(snapshot.rateLimit.windowEndsAt)}
              </p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Prompt tokens processed</p>
              <p className="metric-value">{formatCount(snapshot.usage.promptTokens)}</p>
              <p className="metric-caption">Reported by Gemini across successful requests</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Candidate tokens generated</p>
              <p className="metric-value">{formatCount(snapshot.usage.candidateTokens)}</p>
              <p className="metric-caption">Reported by Gemini across successful requests</p>
            </article>
            <article className="metric-card">
              <p className="metric-label">Model context window</p>
              <p className="metric-value">
                {formatCount(snapshot.usage.contextWindowTokens)}
                {snapshot.usage.contextWindowTokens !== null && <span> tokens</span>}
              </p>
              <p className="metric-caption">Selected model: {snapshot.usage.model}</p>
            </article>
          </section>

          <section className="request-summary">
            <div>
              <span className="summary-dot summary-success" />
              Successful requests <strong>{snapshot.usage.successfulRequests}</strong>
            </div>
            <div>
              <span className="summary-dot summary-error" />
              Failed requests <strong>{snapshot.usage.failedRequests}</strong>
            </div>
            <p>Application request limit is process-local; it is not Google’s provider quota.</p>
          </section>

          <section aria-label="Live system logs" className="logs-panel">
            <div className="logs-heading">
              <div>
                <p className="eyebrow">ACTIVITY</p>
                <h2>Live system logs</h2>
              </div>
              <span>{logs.length} recent events</span>
            </div>
            {logs.length === 0 ? (
              <p className="empty-logs">No API activity recorded yet.</p>
            ) : (
              <ul className="logs-list">
                {logs.map((log) => (
                  <li className="log-row" key={log.id}>
                    <span className={`log-level log-${log.level}`}>{log.level}</span>
                    <span className="log-message">{log.message}</span>
                    <time dateTime={log.timestamp}>{formatTime(log.timestamp)}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <p className="admin-disclaimer">
        Metrics and logs live in this server process&apos;s memory and reset on restart. A
        multi-instance deployment needs shared telemetry and a distributed rate limiter.
      </p>
    </main>
  );
}
