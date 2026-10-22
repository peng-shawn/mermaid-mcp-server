// Runs renders in a child process: keeps the server responsive while a large
// diagram lays out, survives native crashes (a Rust panic in the rasterizer
// aborts its process), and lets a runaway render be killed.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SyntaxIssue } from "./engine/mermaid.js";
import type { RenderJob, RenderOutput, Request, Response, Validation } from "./protocol.js";

export class DiagramSyntaxError extends Error {
  constructor(readonly issue: SyntaxIssue) {
    super(issue.message);
    this.name = "MermaidSyntaxError";
  }
}

export class RenderTimeoutError extends Error {
  constructor(ms: number) {
    super(`Rendering took longer than ${Math.round(ms / 1000)}s and was stopped`);
    this.name = "RenderTimeoutError";
  }
}

export interface RendererOptions {
  timeoutMs?: number;
  // Restart the worker after this many jobs to bound memory growth in jsdom
  recycleAfter?: number;
  log?: (message: string) => void;
}

interface Pending {
  request: Request;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class Renderer {
  private worker: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private jobsOnWorker = 0;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly recycleAfter: number;
  private readonly log: (message: string) => void;

  constructor(options: RendererOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.recycleAfter = options.recycleAfter ?? 250;
    this.log = options.log ?? (() => {});
  }

  // Starts the worker now rather than on the first request (Mermaid and the
  // font index take a moment to load)
  start(): Promise<void> {
    this.ready ??= this.spawn();
    return this.ready;
  }

  render(job: RenderJob): Promise<RenderOutput> {
    return this.enqueue({ id: this.nextId++, op: "render", job });
  }

  validate(code: string): Promise<Validation> {
    return this.enqueue({ id: this.nextId++, op: "validate", code });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new Error("Renderer closed"));
    this.current?.reject(new Error("Renderer closed"));
    this.current = null;
    this.worker?.kill();
    this.worker = null;
  }

  private enqueue<T>(request: Request): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Renderer closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      void this.pump();
    });
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      // stdout is the MCP channel, so the child's stdout is discarded
      const worker = fork(fileURLToPath(new URL("./worker.js", import.meta.url)), [], { serialization: "advanced", stdio: ["ignore", "ignore", "inherit", "ipc"] });
      this.worker = worker;
      this.jobsOnWorker = 0;
      worker.on("message", (msg: Response) => {
        if ("ready" in msg) return resolve();
        if ("fatal" in msg) return reject(new Error(`Render worker failed to start: ${msg.fatal}`));
        this.settle(msg);
      });
      worker.on("error", (err) => {
        this.log(`render worker error: ${err.message}`);
        reject(err);
        this.failCurrent(err);
      });
      worker.on("exit", (code, signal) => {
        const ours = this.worker === worker;
        if (ours) {
          this.worker = null;
          this.ready = null;
        }
        reject(new Error(`Render worker exited before starting (${signal ?? code})`));
        if (ours && !this.closed) this.failCurrent(new Error(`The renderer crashed (${signal ?? `exit code ${code}`}) on this diagram; it has been restarted`));
      });
    });
  }

  private async pump(): Promise<void> {
    if (this.current || !this.queue.length || this.closed) return;
    const next = this.queue.shift()!;
    this.current = next;
    try {
      if (this.jobsOnWorker >= this.recycleAfter && this.worker) {
        const old = this.worker;
        this.worker = null;
        this.ready = null;
        old.kill();
      }
      await this.start();
    } catch (err) {
      this.current = null;
      next.reject(err as Error);
      void this.pump();
      return;
    }
    this.jobsOnWorker++;
    this.timer = setTimeout(() => this.timeout(), this.timeoutMs);
    this.worker!.send(next.request);
  }

  private settle(msg: Extract<Response, { id: number }>): void {
    const p = this.current;
    if (!p || p.request.id !== msg.id) return;
    this.finish();
    if (msg.ok) p.resolve(msg.result);
    else if (msg.error.kind === "syntax") p.reject(new DiagramSyntaxError(msg.error.issue));
    else p.reject(new Error(msg.error.message));
  }

  private timeout(): void {
    const p = this.current;
    if (!p) return;
    this.log(`render ${p.request.id} timed out; restarting worker`);
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    worker?.kill("SIGKILL");
    this.finish();
    p.reject(new RenderTimeoutError(this.timeoutMs));
  }

  private failCurrent(err: Error): void {
    const p = this.current;
    if (!p) return;
    this.finish();
    p.reject(err);
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    queueMicrotask(() => void this.pump());
  }
}
