"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { BridgeConfigSchema, ensureBridgeConfig, updateBridgeConfig } from "../config";
import type { SqliteStore } from "../db";
import type { ProjectRegistry } from "./registry";
import { CONTROL_CENTER_HTML } from "./controlCenterPage";
import {
  SandboxRuntimeAttestationService,
  type SandboxAttestationStatus,
} from "./sandboxRuntimeAttestation";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 4190;
const SESSION_COOKIE = "kb.sid";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_PASSWORD_LENGTH = 14;
const MAX_PASSWORD_LENGTH = 256;
const MAX_TASK_PAGE_SIZE = 200;

interface AuthFile {
  version: 1;
  bootstrapTokenHash: string | null;
  passwordSalt: string | null;
  passwordHash: string | null;
  createdAt: string | null;
}

interface OperatorSession {
  csrfToken: string;
  expiresAt: number;
}

interface LoginWindow {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export interface IntakeControlState {
  enabled: boolean;
  running: boolean;
  dispatcherReady: boolean;
  repositories: string[];
  reason: string | null;
}

export interface IntakeControlActionResult {
  ok: boolean;
  error?: string;
  code?: string;
}

export interface ControlCenterOptions {
  bridgeRoot: string;
  store: SqliteStore;
  registry: ProjectRegistry;
  host?: string;
  port?: number;
  intakeStatus?: () => IntakeControlState;
  intakeStart?: () => Promise<IntakeControlActionResult>;
  intakeStop?: () => IntakeControlActionResult;
  sandboxAttestation?: {
    status(): SandboxAttestationStatus;
    startVerification(): { ok: boolean; code?: string; error?: string; status: SandboxAttestationStatus };
  };
}

export interface ControlCenterStartResult {
  host: string;
  port: number;
  url: string;
}

function authFilePath(bridgeRoot: string): string {
  return path.join(bridgeRoot, "data", "control-center-auth.json");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaultAuthFile(): AuthFile {
  return {
    version: 1,
    bootstrapTokenHash: null,
    passwordSalt: null,
    passwordHash: null,
    createdAt: null,
  };
}

function readAuthFile(file: string): AuthFile {
  if (!fs.existsSync(file)) return defaultAuthFile();
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Control Center authentication file is invalid.");
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1) throw new Error("Unsupported Control Center authentication file version.");
  const nullableString = (entry: unknown): string | null =>
    typeof entry === "string" && entry.length > 0 ? entry : null;
  return {
    version: 1,
    bootstrapTokenHash: nullableString(value.bootstrapTokenHash),
    passwordSalt: nullableString(value.passwordSalt),
    passwordHash: nullableString(value.passwordHash),
    createdAt: nullableString(value.createdAt),
  };
}

function writeAuthFile(file: string, value: AuthFile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Creates a one-time first-run token. Only its SHA-256 digest is persisted.
 * The plain token is returned once so the operator can enter it in the browser.
 */
export function createControlCenterSetupToken(bridgeRoot: string): string {
  const file = authFilePath(path.resolve(bridgeRoot));
  const current = readAuthFile(file);
  if (current.passwordHash) {
    throw new Error("Control Center local authentication is already configured.");
  }
  const token = crypto.randomBytes(32).toString("base64url");
  writeAuthFile(file, {
    version: 1,
    bootstrapTokenHash: sha256(token),
    passwordSalt: null,
    passwordHash: null,
    createdAt: null,
  });
  return token;
}

function derivePassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derived) => {
      if (error) reject(error);
      else resolve(derived.toString("hex"));
    });
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of (header ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) continue;
    try { result[name] = decodeURIComponent(value); } catch { /* ignore malformed cookie */ }
  }
  return result;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sanitizedText(value: unknown, maxLength = 1000): string {
  return String(value ?? "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/ig, "$1[REDACTED]")
    .slice(0, maxLength);
}

function parseBoundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export class ControlCenterServer {
  private readonly bridgeRoot: string;
  private readonly store: SqliteStore;
  private readonly registry: ProjectRegistry;
  private readonly host: string;
  private port: number;
  private readonly authPath: string;
  private readonly intakeStatusCallback?: ControlCenterOptions["intakeStatus"];
  private readonly intakeStartCallback?: ControlCenterOptions["intakeStart"];
  private readonly intakeStopCallback?: ControlCenterOptions["intakeStop"];
  private readonly sandboxAttestation: NonNullable<ControlCenterOptions["sandboxAttestation"]>;
  private server: Server | null = null;
  private readonly sessions = new Map<string, OperatorSession>();
  private readonly loginWindows = new Map<string, LoginWindow>();
  private readonly eventClients = new Map<ServerResponse, string>();
  private eventTimer: NodeJS.Timeout | null = null;
  private lastEventRevision: string | null = null;
  private lastHeartbeatAt = 0;

  constructor(options: ControlCenterOptions) {
    this.bridgeRoot = path.resolve(options.bridgeRoot);
    this.store = options.store;
    this.registry = options.registry;
    this.host = options.host ?? LOOPBACK_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.authPath = authFilePath(this.bridgeRoot);
    this.intakeStatusCallback = options.intakeStatus;
    this.intakeStartCallback = options.intakeStart;
    this.intakeStopCallback = options.intakeStop;
    this.sandboxAttestation = options.sandboxAttestation ??
      new SandboxRuntimeAttestationService({
        bridgeRoot: this.bridgeRoot,
        store: this.store,
        getConfig: () => ensureBridgeConfig(this.bridgeRoot),
        isIntakeRunning: () => this.intakeStatusReadModel().running,
      });
    if (this.host !== LOOPBACK_HOST) {
      throw new Error("Control Center must bind to 127.0.0.1; non-loopback binding is prohibited.");
    }
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new Error("Control Center port must be an integer from 0 to 65535.");
    }
  }

  async start(): Promise<ControlCenterStartResult> {
    if (this.server) throw new Error("Control Center is already running.");
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const statusCode = Number((error as { statusCode?: unknown })?.statusCode);
        const safeStatus = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 499 ? statusCode : 500;
        const message = safeStatus === 500
          ? "Internal Control Center error."
          : sanitizedText((error as Error)?.message ?? "Request rejected.", 200);
        this.sendJson(response, safeStatus, { error: message });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });
    const address = server.address() as AddressInfo;
    this.port = address.port;
    return {
      host: this.host,
      port: this.port,
      url: "http://" + this.host + ":" + this.port + "/",
    };
  }

  async close(): Promise<void> {
    try { this.intakeStopCallback?.(); } catch { /* best effort service shutdown */ }
    this.sessions.clear();
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = null;
    this.lastEventRevision = null;
    for (const response of this.eventClients.keys()) {
      try { response.end(); } catch { /* best effort */ }
    }
    this.eventClients.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private expectedHost(): string {
    return this.host + ":" + this.port;
  }

  private setSecurityHeaders(response: ServerResponse, nonce?: string): void {
    const scriptPolicy = nonce ? "'nonce-" + nonce + "'" : "'none'";
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
      "form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src " + scriptPolicy
    );
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    this.setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private sendHtml(response: ServerResponse): void {
    const nonce = crypto.randomBytes(18).toString("base64");
    const html = CONTROL_CENTER_HTML.replace(/__CSP_NONCE__/g, nonce);
    this.setSecurityHeaders(response, nonce);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw Object.assign(new Error("Content-Type must be application/json."), { statusCode: 415 });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        throw Object.assign(new Error("Request body exceeds the configured size limit."), { statusCode: 413 });
      }
      chunks.push(buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Request body is not valid JSON."), { statusCode: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("Request body must be a JSON object."), { statusCode: 400 });
    }
    return parsed as Record<string, unknown>;
  }

  private validateOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return typeof origin === "string" && origin === "http://" + this.expectedHost();
  }

  private getSession(request: IncomingMessage): { id: string; session: OperatorSession } | null {
    const id = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return { id, session };
  }

  private createSession(response: ServerResponse): { csrfToken: string } {
    const id = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(id, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=" + encodeURIComponent(id) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)
    );
    return { csrfToken };
  }

  private clearSessionCookie(response: ServerResponse): void {
    response.setHeader("Set-Cookie", SESSION_COOKIE + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  }

  private validateCsrf(request: IncomingMessage, session: OperatorSession): boolean {
    const token = request.headers["x-csrf-token"];
    if (typeof token !== "string" || token.length !== session.csrfToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken));
  }

  private loginWindowKey(request: IncomingMessage): string {
    return request.socket.remoteAddress ?? "unknown";
  }

  private isLoginBlocked(request: IncomingMessage): boolean {
    const key = this.loginWindowKey(request);
    const entry = this.loginWindows.get(key);
    if (!entry) return false;
    if (entry.blockedUntil > Date.now()) return true;
    if (Date.now() - entry.windowStartedAt > 15 * 60 * 1000) this.loginWindows.delete(key);
    return false;
  }

  private recordLoginFailure(request: IncomingMessage): void {
    const key = this.loginWindowKey(request);
    const now = Date.now();
    const current = this.loginWindows.get(key);
    const entry = !current || now - current.windowStartedAt > 15 * 60 * 1000
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      : current;
    entry.failures++;
    if (entry.failures >= 5) entry.blockedUntil = now + 60 * 1000;
    this.loginWindows.set(key, entry);
  }

  private clearLoginFailures(request: IncomingMessage): void {
    this.loginWindows.delete(this.loginWindowKey(request));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      this.sendJson(response, 403, { error: "Loopback access only." });
      return;
    }
    if (request.headers.host?.toLowerCase() !== this.expectedHost().toLowerCase()) {
      this.sendJson(response, 400, { error: "Invalid Host header." });
      return;
    }
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      response.setHeader("Allow", "GET, POST");
      this.sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const url = new URL(request.url ?? "/", "http://" + this.expectedHost());
    const route = url.pathname;

    if (route === "/" && method === "GET") {
      this.sendHtml(response);
      return;
    }
    if (route === "/api/auth/status" && method === "GET") {
      const auth = readAuthFile(this.authPath);
      this.sendJson(response, 200, { configured: Boolean(auth.passwordHash) });
      return;
    }

    const unauthenticatedPost = route === "/api/auth/setup" || route === "/api/auth/login";
    if (method === "POST" && !this.validateOrigin(request)) {
      this.sendJson(response, 403, { error: "Request Origin is not allowed." });
      return;
    }

    if (unauthenticatedPost) {
      const body = await this.readJsonBody(request);
      if (route === "/api/auth/setup") {
        await this.handleSetup(request, response, body);
        return;
      }
      await this.handleLogin(request, response, body);
      return;
    }

    const active = this.getSession(request);
    if (!active) {
      this.sendJson(response, 401, { error: "Authentication required." });
      return;
    }
    if (method === "POST" && !this.validateCsrf(request, active.session)) {
      this.sendJson(response, 403, { error: "CSRF token is missing or invalid." });
      return;
    }

    if (route === "/api/session" && method === "GET") {
      this.sendJson(response, 200, { user: "local-operator", csrfToken: active.session.csrfToken, expiresAt: new Date(active.session.expiresAt).toISOString() });
      return;
    }
    if (route === "/api/auth/logout" && method === "POST") {
      this.sessions.delete(active.id);
      this.closeEventStreamsForSession(active.id);
      this.clearSessionCookie(response);
      this.store.insertAudit({ actor: "local-operator", action: "control_center.logout" });
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (route === "/api/events" && method === "GET") {
      this.openEventStream(response, active.id);
      return;
    }
    if (route === "/api/dashboard" && method === "GET") {
      this.sendJson(response, 200, this.dashboard());
      return;
    }
    if (route === "/api/projects" && method === "GET") {
      this.sendJson(response, 200, this.projectsReadModel());
      return;
    }
    if (route === "/api/tasks" && method === "GET") {
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 100, 1, MAX_TASK_PAGE_SIZE);
      const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, 1000000);
      this.sendJson(response, 200, { tasks: this.taskListReadModel(limit, offset), limit, offset });
      return;
    }
    if (route.startsWith("/api/tasks/") && method === "GET") {
      const id = decodeURIComponent(route.slice("/api/tasks/".length));
      const detail = this.taskDetailReadModel(id);
      if (!detail) {
        this.sendJson(response, 404, { error: "Task not found." });
        return;
      }
      this.sendJson(response, 200, detail);
      return;
    }
    if (route === "/api/sandbox/attestation" && method === "GET") {
      this.sendJson(response, 200, this.sandboxAttestation.status());
      return;
    }
    if (route === "/api/sandbox/attestation/verify" && method === "POST") {
      const requestBody = await this.readJsonBody(request);
      if (Object.keys(requestBody).length !== 0) {
        this.sendJson(response, 400, { error: "Sandbox verification does not accept caller-supplied task or runtime parameters." });
        return;
      }
      const outcome = this.sandboxAttestation.startVerification();
      if (!outcome.ok) {
        this.sendJson(response, 409, {
          error: sanitizedText(outcome.error ?? "Sandbox runtime verification could not be started.", 300),
          code: outcome.code ?? "SANDBOX_ATTESTATION_BLOCKED",
          status: outcome.status,
        });
        return;
      }
      this.store.insertAudit({
        actor: "local-operator",
        action: "control_center.sandbox_runtime_verification_started",
        detail: JSON.stringify({ state: outcome.status.state, startedAt: outcome.status.startedAt }),
      });
      this.sendJson(response, 202, { ok: true, status: outcome.status });
      return;
    }
    if (route === "/api/intake/status" && method === "GET") {
      this.sendJson(response, 200, this.intakeStatusReadModel());
      return;
    }
    if (route === "/api/intake/start" && method === "POST") {
      if (!this.intakeStartCallback) {
        this.sendJson(response, 503, { error: "GitHub intake controls are not connected to the Bridge app." });
        return;
      }
      const outcome = await this.intakeStartCallback();
      if (!outcome.ok) {
        this.sendJson(response, 409, {
          error: sanitizedText(outcome.error ?? "GitHub intake could not be started.", 300),
          code: outcome.code ?? "INTAKE_START_BLOCKED",
          status: this.intakeStatusReadModel(),
        });
        return;
      }
      this.store.insertAudit({ actor: "local-operator", action: "control_center.github_intake_started" });
      this.sendJson(response, 200, { ok: true, status: this.intakeStatusReadModel() });
      return;
    }
    if (route === "/api/intake/stop" && method === "POST") {
      if (!this.intakeStopCallback) {
        this.sendJson(response, 503, { error: "GitHub intake controls are not connected to the Bridge app." });
        return;
      }
      const outcome = this.intakeStopCallback();
      if (!outcome.ok) {
        this.sendJson(response, 409, { error: sanitizedText(outcome.error ?? "GitHub intake could not be stopped.", 300) });
        return;
      }
      this.store.insertAudit({ actor: "local-operator", action: "control_center.github_intake_stopped" });
      this.sendJson(response, 200, { ok: true, status: this.intakeStatusReadModel() });
      return;
    }
    if (route === "/api/intake-claims" && method === "GET") {
      this.sendJson(response, 200, { claims: this.claimReadModel() });
      return;
    }
    if (route === "/api/audit" && method === "GET") {
      this.sendJson(response, 200, { events: this.auditReadModel() });
      return;
    }
    if (route === "/api/settings" && method === "GET") {
      this.sendJson(response, 200, this.settingsReadModel());
      return;
    }

    if (route === "/api/settings" && method === "POST") {
      const body = await this.readJsonBody(request);
      await this.updateSettings(response, body);
      return;
    }

    if (route.startsWith("/api/projects/") && route.endsWith("/state") && method === "POST") {
      const projectId = decodeURIComponent(route.slice("/api/projects/".length, -"/state".length));
      if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(projectId)) {
        this.sendJson(response, 400, { error: "Project identifier is invalid." });
        return;
      }
      const body = await this.readJsonBody(request);
      const state = body.state;
      if (state !== "active" && state !== "disabled") {
        this.sendJson(response, 400, { error: "Project state must be 'active' or 'disabled'." });
        return;
      }
      const result = state === "active" ? this.registry.enable(projectId) : this.registry.disable(projectId);
      if (!result.ok) {
        this.sendJson(response, 404, { error: sanitizedText(result.error, 200) });
        return;
      }
      this.store.insertAudit({
        projectId,
        actor: "local-operator",
        action: "control_center.project_state_changed",
        detail: JSON.stringify({ state }),
      });
      this.sendJson(response, 200, this.projectsReadModel());
      return;
    }

    if (method === "POST") {
      const body = await this.readJsonBody(request);
      void body;
      this.sendJson(response, 404, { error: "Route not found." });
      return;
    }
    this.sendJson(response, 404, { error: "Route not found." });
  }

  private openEventStream(response: ServerResponse, sessionId: string): void {
    let revision: string;
    try {
      revision = this.store.getOperationalRevision();
    } catch {
      this.sendJson(response, 503, { error: "Operational event feed is temporarily unavailable." });
      return;
    }
    const activeForSession = [...this.eventClients.values()].filter((id) => id === sessionId).length;
    if (activeForSession >= 2) {
      this.sendJson(response, 429, { error: "Too many open event streams for this session." });
      return;
    }

    this.setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    response.write("retry: 3000\n\n");
    response.write(
      "id: " + revision + "\n" +
      "event: snapshot\n" +
      "data: " + JSON.stringify({ revision, capturedAt: new Date().toISOString() }) + "\n\n"
    );
    this.eventClients.set(response, sessionId);
    response.on("close", () => this.removeEventStream(response));

    if (!this.eventTimer) {
      this.lastEventRevision = revision;
      this.lastHeartbeatAt = Date.now();
      this.eventTimer = setInterval(() => this.broadcastOperationalChanges(), 2000);
    }
  }

  private removeEventStream(response: ServerResponse): void {
    this.eventClients.delete(response);
    if (this.eventClients.size === 0 && this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
      this.lastEventRevision = null;
    }
  }

  private closeEventStreamsForSession(sessionId: string): void {
    for (const [response, owner] of this.eventClients) {
      if (owner !== sessionId) continue;
      this.eventClients.delete(response);
      try { response.end(); } catch { /* best effort */ }
    }
    if (this.eventClients.size === 0 && this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
      this.lastEventRevision = null;
    }
  }

  private broadcastOperationalChanges(): void {
    if (this.eventClients.size === 0) {
      if (this.eventTimer) clearInterval(this.eventTimer);
      this.eventTimer = null;
      this.lastEventRevision = null;
      return;
    }
    let revision: string;
    try {
      revision = this.store.getOperationalRevision();
    } catch {
      for (const response of this.eventClients.keys()) {
        try { response.write("event: unavailable\ndata: {}\n\n"); } catch { /* best effort */ }
      }
      return;
    }

    const now = Date.now();
    if (revision !== this.lastEventRevision) {
      this.lastEventRevision = revision;
      const payload = "id: " + revision + "\n" +
        "event: refresh\n" +
        "data: " + JSON.stringify({ revision, changedAt: new Date(now).toISOString() }) + "\n\n";
      for (const response of this.eventClients.keys()) {
        if (response.destroyed || response.writableEnded) {
          this.removeEventStream(response);
          continue;
        }
        try { response.write(payload); } catch { this.removeEventStream(response); }
      }
      this.lastHeartbeatAt = now;
    } else if (now - this.lastHeartbeatAt >= 15000) {
      for (const response of this.eventClients.keys()) {
        if (response.destroyed || response.writableEnded) {
          this.removeEventStream(response);
          continue;
        }
        try { response.write(": keep-alive\n\n"); } catch { this.removeEventStream(response); }
      }
      this.lastHeartbeatAt = now;
    }
  }

  private async handleSetup(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>
  ): Promise<void> {
    const auth = readAuthFile(this.authPath);
    if (auth.passwordHash) {
      this.sendJson(response, 409, { error: "Local operator account is already configured." });
      return;
    }
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!auth.bootstrapTokenHash || !timingSafeHexEqual(auth.bootstrapTokenHash, sha256(token))) {
      this.recordLoginFailure(request);
      this.sendJson(response, 401, { error: "Invalid or expired setup token." });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      this.sendJson(response, 400, { error: "Password must be 14 to 256 characters long." });
      return;
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await derivePassword(password, salt);
    writeAuthFile(this.authPath, {
      version: 1,
      bootstrapTokenHash: null,
      passwordSalt: salt,
      passwordHash,
      createdAt: new Date().toISOString(),
    });
    this.clearLoginFailures(request);
    const session = this.createSession(response);
    this.store.insertAudit({ actor: "local-operator", action: "control_center.setup" });
    this.sendJson(response, 201, { ok: true, csrfToken: session.csrfToken });
  }

  private async handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>
  ): Promise<void> {
    if (this.isLoginBlocked(request)) {
      this.sendJson(response, 429, { error: "Too many failed sign-in attempts. Try again in one minute." });
      return;
    }
    const auth = readAuthFile(this.authPath);
    const password = typeof body.password === "string" ? body.password : "";
    if (!auth.passwordHash || !auth.passwordSalt || password.length > MAX_PASSWORD_LENGTH) {
      this.recordLoginFailure(request);
      this.sendJson(response, 401, { error: "Invalid sign-in details." });
      return;
    }
    const candidate = await derivePassword(password, auth.passwordSalt);
    if (!timingSafeHexEqual(candidate, auth.passwordHash)) {
      this.recordLoginFailure(request);
      this.sendJson(response, 401, { error: "Invalid sign-in details." });
      return;
    }
    this.clearLoginFailures(request);
    const session = this.createSession(response);
    this.store.insertAudit({ actor: "local-operator", action: "control_center.login" });
    this.sendJson(response, 200, { ok: true, csrfToken: session.csrfToken });
  }

  private intakeStatusReadModel(): IntakeControlState {
    try {
      if (this.intakeStatusCallback) return this.intakeStatusCallback();
      const config = ensureBridgeConfig(this.bridgeRoot);
      return {
        enabled: config.githubIntakeEnabled,
        running: false,
        dispatcherReady: false,
        repositories: [...config.githubIntakeAllowedRepositories],
        reason: "GitHub intake lifecycle callbacks are not connected to the Bridge app.",
      };
    } catch {
      return {
        enabled: false,
        running: false,
        dispatcherReady: false,
        repositories: [],
        reason: "Bridge intake status could not be read.",
      };
    }
  }

  private settingsReadModel(): Record<string, unknown> {
    const config = ensureBridgeConfig(this.bridgeRoot);
    const worker = this.workerReadModel();
    const providerApiKeyPresent = Boolean(
      config.sandboxProviderApiKeyEnv &&
      process.env[config.sandboxProviderApiKeyEnv]
    );
    const sandboxKiloExecutable =
      config.sandboxKiloExePath.trim() || process.env.KILO_SANDBOX_EXE || "";
    const intakeStatus = this.intakeStatusReadModel();
    return {
      gates: {
        workerEnabled: config.workerEnabled,
        githubIntakeEnabled: config.githubIntakeEnabled,
        sandboxExecutionEnabled: config.sandboxExecutionEnabled,
        ghEnabled: config.ghEnabled,
        kiloEnabled: config.kiloEnabled,
        githubIntakeAllowedRepositories: config.githubIntakeAllowedRepositories,
      },
      pollIntervalMs: config.pollIntervalMs,
      workerRunning: worker.running,
      intakeRuntimeAvailable: intakeStatus.dispatcherReady,
      intakeRuntimeReason: intakeStatus.reason,
      sandbox: {
        kiloExecutableConfigured: Boolean(sandboxKiloExecutable),
        kiloExecutableName: sandboxKiloExecutable ? path.win32.basename(sandboxKiloExecutable) : null,
        providerBaseUrl: config.sandboxProviderBaseUrl,
        providerModelId: config.sandboxProviderModelId,
        providerApiKeyEnv: config.sandboxProviderApiKeyEnv,
        providerApiKeyPresent,
        providerApiKeyHeader: config.sandboxProviderApiKeyHeader,
        providerApiKeyPrefix: config.sandboxProviderApiKeyPrefix,
      },
      runtimeAttestation: this.sandboxAttestation.status(),
    };
  }

  private async updateSettings(
    response: ServerResponse,
    body: Record<string, unknown>
  ): Promise<void> {
    const allowed = new Set([
      "githubIntakeEnabled",
      "workerEnabled",
      "sandboxExecutionEnabled",
      "ghEnabled",
      "kiloEnabled",
      "githubIntakeAllowedRepositories",
      "pollIntervalMs",
      "sandboxKiloExePath",
      "sandboxProviderBaseUrl",
      "sandboxProviderApiKeyEnv",
      "sandboxProviderModelId",
      "sandboxProviderApiKeyHeader",
      "sandboxProviderApiKeyPrefix",
    ]);
    const fields = Object.keys(body);
    if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
      this.sendJson(response, 400, { error: "Settings request contains no changes or an unsupported field." });
      return;
    }

    // The generic worker remains permanently outside this dedicated intake
    // authorization flow. Sandbox execution requires a current signed runtime
    // attestation. Dedicated intake is a second, explicit gate after Sandbox
    // has already been enabled and its current dispatcher prerequisites pass.
    if (body.workerEnabled === true) {
      this.sendJson(response, 409, {
        error: "The legacy generic worker cannot be enabled from the dedicated Control Center workflow.",
      });
      return;
    }
    if (body.sandboxExecutionEnabled === true || body.githubIntakeEnabled === true) {
      const attestation = this.sandboxAttestation.status();
      if (!attestation.valid) {
        this.sendJson(response, 409, {
          error: attestation.reason ?? "A current Windows Sandbox runtime attestation is required.",
          code: "SANDBOX_ATTESTATION_REQUIRED",
          status: attestation,
        });
        return;
      }
      if (body.githubIntakeEnabled === true) {
        const current = ensureBridgeConfig(this.bridgeRoot);
        if (body.sandboxExecutionEnabled === true || body.sandboxExecutionEnabled === false || !current.sandboxExecutionEnabled) {
          this.sendJson(response, 409, {
            error: "Windows Sandbox execution must already be enabled and cannot be disabled in the same request that enables GitHub intake.",
            code: "SANDBOX_GATE_MUST_ALREADY_BE_ENABLED",
          });
          return;
        }
        const prerequisites = {
          ghEnabled: "ghEnabled" in body ? body.ghEnabled === true : current.ghEnabled,
          kiloEnabled: "kiloEnabled" in body ? body.kiloEnabled === true : current.kiloEnabled,
        };
        const trustedRepositories = "githubIntakeAllowedRepositories" in body &&
          Array.isArray(body.githubIntakeAllowedRepositories)
          ? body.githubIntakeAllowedRepositories
          : current.githubIntakeAllowedRepositories;
        if (!prerequisites.ghEnabled || !prerequisites.kiloEnabled ||
            trustedRepositories.length === 0) {
          this.sendJson(response, 409, {
            error: "GitHub and Kilo prerequisites must be enabled and at least one trusted repository must be configured before intake activation.",
            code: "INTAKE_PREREQUISITES_INCOMPLETE",
          });
          return;
        }
        const intake = this.intakeStatusReadModel();
        if (!intake.dispatcherReady) {
          this.sendJson(response, 409, {
            error: intake.reason ?? "The claim-bound Sandbox dispatcher is not ready.",
            code: "INTAKE_DISPATCHER_NOT_READY",
          });
          return;
        }
      }
    }
    if (body.sandboxExecutionEnabled === false) {
      const current = ensureBridgeConfig(this.bridgeRoot);
      const intakeWillRemainEnabled = "githubIntakeEnabled" in body
        ? body.githubIntakeEnabled === true
        : current.githubIntakeEnabled;
      if (intakeWillRemainEnabled) {
        this.sendJson(response, 409, {
          error: "Disable dedicated GitHub intake before disabling the Sandbox execution gate.",
          code: "INTAKE_GATE_MUST_BE_DISABLED_FIRST",
        });
        return;
      }
    }

    for (const key of ["githubIntakeEnabled", "workerEnabled", "sandboxExecutionEnabled", "ghEnabled", "kiloEnabled"]) {
      if (key in body && typeof body[key] !== "boolean") {
        this.sendJson(response, 400, { error: key + " must be a boolean." });
        return;
      }
    }

    const runtimeBoundFields = [
      "sandboxKiloExePath",
      "sandboxProviderBaseUrl",
      "sandboxProviderApiKeyEnv",
      "sandboxProviderModelId",
      "sandboxProviderApiKeyHeader",
      "sandboxProviderApiKeyPrefix",
    ];
    if (runtimeBoundFields.some((field) => field in body)) {
      const current = ensureBridgeConfig(this.bridgeRoot);
      const sandboxWillRemainEnabled = "sandboxExecutionEnabled" in body
        ? body.sandboxExecutionEnabled === true
        : current.sandboxExecutionEnabled;
      const intakeWillRemainEnabled = "githubIntakeEnabled" in body
        ? body.githubIntakeEnabled === true
        : current.githubIntakeEnabled;
      if (sandboxWillRemainEnabled || intakeWillRemainEnabled) {
        this.sendJson(response, 409, {
          error: "Disable GitHub intake and Windows Sandbox execution before changing a runtime-bound executable or provider setting; a new attestation will be required.",
          code: "RUNTIME_SETTINGS_REQUIRE_GATES_OFF",
        });
        return;
      }
    }
    if ("pollIntervalMs" in body &&
      (typeof body.pollIntervalMs !== "number" || !Number.isSafeInteger(body.pollIntervalMs) || body.pollIntervalMs < 1000 || body.pollIntervalMs > 3600000)) {
      this.sendJson(response, 400, { error: "pollIntervalMs must be an integer from 1000 to 3600000." });
      return;
    }
    if ("githubIntakeAllowedRepositories" in body &&
      (!Array.isArray(body.githubIntakeAllowedRepositories) ||
       !body.githubIntakeAllowedRepositories.every((entry) => typeof entry === "string"))) {
      this.sendJson(response, 400, { error: "githubIntakeAllowedRepositories must be an array of owner/repo strings." });
      return;
    }

    if ("sandboxKiloExePath" in body) {
      if (typeof body.sandboxKiloExePath !== "string" || body.sandboxKiloExePath.length > 2048) {
        this.sendJson(response, 400, { error: "sandboxKiloExePath must be a string no longer than 2048 characters." });
        return;
      }
      const executable = body.sandboxKiloExePath.trim();
      if (executable) {
        if (!path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== ".exe" || !fs.existsSync(executable)) {
          this.sendJson(response, 400, { error: "sandboxKiloExePath must be an absolute path to an existing .exe file." });
          return;
        }
        try {
          const stat = fs.lstatSync(executable);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            this.sendJson(response, 400, { error: "sandboxKiloExePath must reference a regular, non-symbolic-link file." });
            return;
          }
        } catch {
          this.sendJson(response, 400, { error: "sandboxKiloExePath could not be inspected safely." });
          return;
        }
      }
    }

    if ("sandboxProviderBaseUrl" in body) {
      if (typeof body.sandboxProviderBaseUrl !== "string" || body.sandboxProviderBaseUrl.length > 2048) {
        this.sendJson(response, 400, { error: "sandboxProviderBaseUrl must be a string no longer than 2048 characters." });
        return;
      }
      const raw = body.sandboxProviderBaseUrl.trim();
      if (raw) {
        try {
          const url = new URL(raw);
          if (
            url.username || url.password || url.search || url.hash ||
            !(url.protocol === "https:" ||
              (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
          ) {
            this.sendJson(response, 400, { error: "sandboxProviderBaseUrl must use HTTPS or loopback HTTP and must not include credentials, query strings, or fragments." });
            return;
          }
        } catch {
          this.sendJson(response, 400, { error: "sandboxProviderBaseUrl must be a valid URL." });
          return;
        }
      }
    }

    const stringLimits: Array<[string, number]> = [
      ["sandboxProviderApiKeyEnv", 128],
      ["sandboxProviderModelId", 160],
      ["sandboxProviderApiKeyHeader", 64],
      ["sandboxProviderApiKeyPrefix", 32],
    ];
    for (const [key, maxLength] of stringLimits) {
      if (key in body && (typeof body[key] !== "string" || (body[key] as string).length > maxLength)) {
        this.sendJson(response, 400, { error: key + " must be a string no longer than " + maxLength + " characters." });
        return;
      }
    }
    if ("sandboxProviderApiKeyEnv" in body) {
      const envName = (body.sandboxProviderApiKeyEnv as string).trim();
      if (envName && !/^[A-Z_][A-Z0-9_]*$/i.test(envName)) {
        this.sendJson(response, 400, { error: "sandboxProviderApiKeyEnv must be a valid environment-variable name." });
        return;
      }
    }
    if ("sandboxProviderModelId" in body && /[\r\n\0]/.test(body.sandboxProviderModelId as string)) {
      this.sendJson(response, 400, { error: "sandboxProviderModelId must not contain control characters." });
      return;
    }
    if ("sandboxProviderApiKeyHeader" in body && !/^[A-Za-z0-9-]{1,64}$/.test(body.sandboxProviderApiKeyHeader as string)) {
      this.sendJson(response, 400, { error: "sandboxProviderApiKeyHeader contains unsupported characters." });
      return;
    }
    if ("sandboxProviderApiKeyPrefix" in body && /[\r\n]/.test(body.sandboxProviderApiKeyPrefix as string)) {
      this.sendJson(response, 400, { error: "sandboxProviderApiKeyPrefix must not contain line breaks." });
      return;
    }

    try {
      const updated = updateBridgeConfig(this.bridgeRoot, (current) => {
        const candidate = { ...current, ...body };
        const parsed = BridgeConfigSchema.safeParse(candidate);
        if (!parsed.success) {
          throw Object.assign(new Error(parsed.error.issues.map((issue) => issue.message).join("; ")), { statusCode: 400 });
        }
        return parsed.data;
      });
      this.store.insertAudit({
        actor: "local-operator",
        action: "control_center.settings_changed",
        detail: JSON.stringify({
          fields: fields.sort(),
          repositoryCount: updated.githubIntakeAllowedRepositories.length,
          pollIntervalMs: updated.pollIntervalMs,
          ghEnabled: updated.ghEnabled,
          kiloEnabled: updated.kiloEnabled,
          sandboxExecutionEnabled: updated.sandboxExecutionEnabled,
          providerApiKeyPresent: Boolean(updated.sandboxProviderApiKeyEnv && process.env[updated.sandboxProviderApiKeyEnv]),
        }),
      });
      this.sendJson(response, 200, this.settingsReadModel());
    } catch (error) {
      const statusCode = Number((error as { statusCode?: unknown })?.statusCode);
      const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 499 ? statusCode : 400;
      this.sendJson(response, status, { error: sanitizedText((error as Error)?.message ?? "Invalid settings.", 300) });
    }
  }

  private workerReadModel(): { running: boolean; pid: number | null; heartbeat: string | null } {
    const file = path.join(this.bridgeRoot, "data", "worker.lock");
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const pid = Number(value.pid);
      const heartbeat = typeof value.heartbeat === "string" ? value.heartbeat : null;
      const age = heartbeat ? Date.now() - new Date(heartbeat).getTime() : Number.POSITIVE_INFINITY;
      return {
        running: Number.isSafeInteger(pid) && pid > 0 && age >= -30_000 && age < 30 * 60 * 1000,
        pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
        heartbeat,
      };
    } catch {
      return { running: false, pid: null, heartbeat: null };
    }
  }

  private dashboard(): Record<string, unknown> {
    const config = ensureBridgeConfig(this.bridgeRoot);
    const projects = this.registry.list();
    const tasks = this.taskListReadModel(50, 0);
    const claims = this.claimReadModel();
    const activeExecutions = this.store.countExecutionsByStatus("RUNNING");
    const worker = this.workerReadModel();
    const intake = this.intakeStatusReadModel();
    return {
      generatedAt: new Date().toISOString(),
      gates: {
        workerEnabled: config.workerEnabled,
        githubIntakeEnabled: config.githubIntakeEnabled,
      },
      services: {
        worker: worker,
        intake: {
          available: intake.dispatcherReady,
          enabled: intake.enabled,
          running: intake.running,
          reason: intake.reason,
          repositories: intake.repositories,
        },
      },
      counts: {
        projects: projects.length,
        tasksReturned: tasks.length,
        intakeClaims: claims.filter((claim) => ["CLAIMED", "TASK_CREATED", "DISPATCHING", "RUNNING", "RECONCILIATION_REQUIRED"].includes(String(claim.status))).length,
        activeExecutions,
      },
      recentTasks: tasks.slice(0, 12),
    };
  }

  private projectsReadModel(): Record<string, unknown> {
    return {
      projects: this.registry.list().map(({ config, state }) => ({
        id: config.id,
        name: config.name,
        repository: config.repository,
        state,
        allowedAuthors: config.allowedAuthors,
      })),
    };
  }

  private taskListReadModel(limit: number, offset: number): Array<Record<string, unknown>> {
    return this.store.listTasks(limit, offset).map((task) => ({
      id: task.id,
      projectId: task.projectId,
      issueNumber: task.issueNumber,
      issueUrl: task.issueUrl,
      title: task.title,
      author: task.author,
      status: task.status,
      attempt: task.attempt,
      executionId: task.executionId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }));
  }

  private taskDetailReadModel(id: string): Record<string, unknown> | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    const executions = this.store.listExecutions(id);
    const verifications = executions.flatMap((execution) =>
      this.store.listVerifications(execution.id).map((verification) => ({
        id: verification.id,
        executionId: verification.executionId,
        name: verification.name,
        passed: verification.passed,
        exitCode: verification.exitCode,
        durationMs: verification.durationMs,
        startTime: verification.startTime,
        endTime: verification.endTime,
      }))
    );
    return {
      task: {
        id: task.id,
        projectId: task.projectId,
        issueNumber: task.issueNumber,
        issueUrl: task.issueUrl,
        title: task.title,
        author: task.author,
        body: task.body,
        status: task.status,
        attempt: task.attempt,
        executionId: task.executionId,
        featureBranch: task.featureBranch,
        leaseExpiresAt: task.leaseExpiresAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      transitions: this.store.listTransitions(id).map((transition) => ({
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        actor: transition.actor,
        reason: sanitizedText(transition.reason, 300),
        createdAt: transition.createdAt,
      })),
      executions: executions.map((execution) => ({
        id: execution.id,
        status: execution.status,
        attempt: execution.attempt,
        startTime: execution.startTime,
        endTime: execution.endTime,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        kiloVersion: execution.kiloVersion,
        model: execution.kiloModel,
        agent: execution.kiloAgent,
        errorMessage: sanitizedText(execution.errorMessage, 500),
      })),
      verifications,
      reports: this.store.getReports(id).map((report) => ({
        id: report.id,
        executionId: report.executionId,
        status: report.status,
        issueCommentId: report.issueCommentId,
        postedAt: report.postedAt,
        createdAt: report.createdAt,
      })),
    };
  }

  private claimReadModel(): Array<Record<string, unknown>> {
    return this.store.listGitHubIntakeClaims().slice(0, 200).map((claim) => ({
      id: claim.id,
      repositoryFullName: claim.repositoryFullName,
      issueNumber: claim.issueNumber,
      assignmentGeneration: claim.assignmentGeneration,
      projectId: claim.projectId,
      taskId: claim.taskId,
      status: claim.status,
      updatedAt: claim.updatedAt,
      lastError: sanitizedText(claim.lastError, 500),
    }));
  }

  private auditReadModel(): Array<Record<string, unknown>> {
    return this.store.listAudit().slice(-200).reverse().map((event) => ({
      projectId: event.projectId,
      actor: event.actor,
      action: event.action,
      createdAt: event.createdAt,
    }));
  }
}
