/**
 * Visual Studio Copilot session parser.
 *
 * VS stores sessions as binary MessagePack streams:
 *   [version, header, ...messages]
 *
 * The server decodes these to a JSON envelope:
 *   { _format: "visual-studio", version, header, messages }
 *
 * The client can also decode raw binary via parseVisualStudioBinary().
 */

import type {
  NormalizedEvent,
  SessionTurn,
  SessionMetadata,
  ParsedSession,
  TokenUsage,
} from "./sessionTypes";

// -- Types for decoded VS session data --

interface VSHeader {
  Name?: string | null;
  User?: { Name?: string };
  TimeCreated?: string | Record<string, unknown>;
  TimeUpdated?: string | Record<string, unknown>;
  Id?: unknown[];
  SelectedAgent?: { Name?: string; Service?: { Name?: string } };
  Responders?: unknown[];
  ConversationMode?: string;
  SessionProgressState?: string | null;
  [key: string]: unknown;
}

interface VSContentEntry {
  Id?: unknown;
  Content?: string;
  Visibility?: number;
  Annotations?: unknown[];
  Mentions?: unknown[];
  Function?: {
    Id?: unknown[];
    Name?: string;
    Arguments?: unknown[];
  };
  Result?: unknown[];
  Status?: number;
  ReasoningTokenCount?: number | null;
  Source?: number;
  [key: string]: unknown;
}

interface VSMessageBody {
  CorrelationId?: string;
  MessageId?: string;
  Content?: Array<[number, VSContentEntry]>;
  Model?: string | { ModelId?: string; Id?: string; Family?: string; DisplayName?: string; [key: string]: unknown } | unknown[];
  Author?: { Name?: string; Service?: { Name?: string } };
  Status?: number;
  Metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface VSMessage {
  "0"?: number;
  "1"?: VSMessageBody;
  [key: string]: unknown;
}

export interface VSSessionData {
  _format: "visual-studio";
  version: number;
  header: VSHeader;
  messages: VSMessage[];
}

// -- Content kind constants --
const KIND_TEXT = 3;
const KIND_TOOL_CALL = 7;
const KIND_REASONING = 10;

// -- Detection --

export function detectVisualStudio(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return isVSSessionEnvelope(parsed);
  } catch {
    return false;
  }
}

function isVSSessionEnvelope(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o._format === "visual-studio" &&
    typeof o.version === "number" &&
    o.header != null &&
    Array.isArray(o.messages)
  );
}

// -- Model extraction --

function extractModelName(model: unknown): string | null {
  if (typeof model === "string") return model;
  if (Array.isArray(model) && model.length >= 2 && model[1]) {
    const info = model[1] as Record<string, unknown>;
    return (info.Id as string) || (info.ModelId as string) || (info.Family as string) || null;
  }
  if (model && typeof model === "object") {
    const m = model as Record<string, unknown>;
    return (m.ModelId as string) || (m.Id as string) || (m.Family as string) || null;
  }
  return null;
}

// -- Tool call argument extraction --

function extractToolArguments(args: unknown[]): unknown {
  if (!Array.isArray(args) || args.length < 2) return null;
  const payload = args[1];
  if (payload && typeof payload === "object" && "json" in (payload as Record<string, unknown>)) {
    try {
      return JSON.parse((payload as Record<string, unknown>).json as string);
    } catch {
      return (payload as Record<string, unknown>).json;
    }
  }
  return payload;
}

// -- Tool result extraction --

function extractToolResult(result: unknown[]): string | null {
  if (!Array.isArray(result) || result.length < 2) return null;
  const wrapper = result[1];
  if (!wrapper || typeof wrapper !== "object") return null;
  const w = wrapper as Record<string, unknown>;

  // Result format: [0, { Value: { ValueContainer: ["System.String", buffer_or_string] } }]
  if (w.Value && typeof w.Value === "object") {
    const vc = (w.Value as Record<string, unknown>).ValueContainer;
    if (Array.isArray(vc) && vc.length >= 2) {
      const data = vc[1];
      if (typeof data === "string") return data;
      if (data && typeof data === "object" && "data" in (data as Record<string, unknown>)) {
        // Buffer-like: { type: "Buffer", data: [...] }
        const bytes = (data as Record<string, unknown>).data;
        if (Array.isArray(bytes)) {
          // Decode as UTF-8 -- first 2 bytes may be msgpack length prefix, skip them
          const arr = bytes as number[];
          // Find the start of the actual string (skip msgpack fixstr/str8/str16 prefix)
          let start = 0;
          if (arr.length > 0) {
            const b0 = arr[0];
            if ((b0 & 0xe0) === 0xa0) { start = 1; } // fixstr
            else if (b0 === 0xd9) { start = 2; } // str 8
            else if (b0 === 0xda) { start = 3; } // str 16
            else if (b0 === 0xdb) { start = 5; } // str 32
          }
          return String.fromCharCode(...arr.slice(start));
        }
      }
    }
  }
  return null;
}

// -- Session ID extraction --

function extractSessionId(header: VSHeader): string | null {
  if (Array.isArray(header.Id) && header.Id.length > 0) {
    const first = header.Id[0];
    if (typeof first === "string") return first;
  }
  return null;
}

// -- Timestamp helpers --

function parseTimestamp(ts: unknown): number | null {
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.getTime() / 1000;
  }
  return null;
}

// -- Main parser --

export function parseVisualStudioJSON(text: string): ParsedSession | null {
  let data: VSSessionData;
  try {
    data = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!isVSSessionEnvelope(data)) return null;
  return buildSession(data);
}

export function parseVisualStudioFromDecoded(items: unknown[]): ParsedSession | null {
  if (items.length < 2) return null;
  const version = items[0] as number;
  const header = items[1] as VSHeader;
  const messages: VSMessage[] = [];
  for (let i = 2; i < items.length; i++) {
    messages.push(items[i] as VSMessage);
  }
  return buildSession({ _format: "visual-studio", version, header, messages });
}

function buildSession(data: VSSessionData): ParsedSession | null {
  const { header, messages } = data;
  const events: NormalizedEvent[] = [];
  const turns: SessionTurn[] = [];
  const models: Record<string, number> = {};

  const sessionStartSec = parseTimestamp(header.TimeCreated) || 0;
  let currentTime = sessionStartSec;
  let turnIndex = 0;
  const agentName = header.SelectedAgent?.Name || "GitHub Copilot";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgType = msg["0"] ?? (msg as Record<number, unknown>)[0];
    const body = (msg["1"] ?? (msg as Record<number, unknown>)[1]) as VSMessageBody | undefined;
    if (!body || !body.Content) continue;

    const isUser = msgType === 0;
    const model = isUser ? extractModelName(body.Model) : extractModelName(body.Model);
    if (model) models[model] = (models[model] || 0) + 1;

    if (isUser) {
      // Start a new turn
      const turnStart = currentTime;
      const turnEvents: number[] = [];

      // Extract user text
      for (const entry of body.Content) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [kind, payload] = entry as [number, VSContentEntry];
        if (kind === KIND_TEXT && payload.Content) {
          const idx = events.length;
          events.push({
            t: currentTime,
            agent: "user",
            track: "context" as NormalizedEvent["track"],
            text: payload.Content,
            duration: 0,
            intensity: 0.3,
            isError: false,
            turnIndex: turnIndex,
            model: model,
          });
          turnEvents.push(idx);
          currentTime += 0.5;
        }
      }

      // Consume the matching response (next message should be type 1)
      const nextMsg = messages[i + 1];
      const nextType = nextMsg ? (nextMsg["0"] ?? (nextMsg as Record<number, unknown>)[0]) : undefined;
      if (nextMsg && nextType === 1) {
        i++; // skip response in outer loop
        const respBody = (nextMsg["1"] ?? (nextMsg as Record<number, unknown>)[1]) as VSMessageBody | undefined;
        const respModel = respBody ? extractModelName(respBody.Model) : null;
        if (respModel) models[respModel] = (models[respModel] || 0) + 1;

        if (respBody?.Content) {
          for (const entry of respBody.Content) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const [kind, payload] = entry as [number, VSContentEntry];

            if (kind === KIND_REASONING) {
              const idx = events.length;
              events.push({
                t: currentTime,
                agent: "assistant",
                track: "reasoning" as NormalizedEvent["track"],
                text: payload.Content || "(thinking)",
                duration: 1,
                intensity: 0.5,
                isError: false,
                turnIndex: turnIndex,
                model: respModel || model,
                tokenUsage: payload.ReasoningTokenCount
                  ? { outputTokens: payload.ReasoningTokenCount }
                  : null,
              });
              turnEvents.push(idx);
              currentTime += 1;
            } else if (kind === KIND_TOOL_CALL && payload.Function) {
              const toolName = payload.Function.Name || "unknown_tool";
              const toolInput = payload.Function.Arguments
                ? extractToolArguments(payload.Function.Arguments)
                : null;
              const toolResult = payload.Result
                ? extractToolResult(payload.Result)
                : null;
              const isError = payload.Status != null && payload.Status !== 1;

              const idx = events.length;
              events.push({
                t: currentTime,
                agent: "assistant",
                track: "tool_call" as NormalizedEvent["track"],
                text: toolResult || toolName,
                duration: 2,
                intensity: 0.8,
                isError: isError,
                turnIndex: turnIndex,
                toolName: toolName,
                toolInput: toolInput,
                model: respModel || model,
                raw: {
                  functionName: toolName,
                  arguments: toolInput,
                  result: toolResult,
                },
              });
              turnEvents.push(idx);
              currentTime += 2;
            } else if (kind === KIND_TEXT && payload.Content) {
              const idx = events.length;
              events.push({
                t: currentTime,
                agent: "assistant",
                track: "output" as NormalizedEvent["track"],
                text: payload.Content,
                duration: 1,
                intensity: 0.6,
                isError: false,
                turnIndex: turnIndex,
                model: respModel || model,
              });
              turnEvents.push(idx);
              currentTime += 1;
            }
          }
        }
      }

      // Finalize turn
      const turnEnd = currentTime;
      turns.push({
        index: turnIndex,
        startTime: turnStart,
        endTime: turnEnd,
        eventIndices: turnEvents,
        userMessage: events[turnEvents[0]]?.text,
        toolCount: turnEvents.filter(
          (idx) => events[idx].track === "tool_call"
        ).length,
        hasError: turnEvents.some((idx) => events[idx].isError),
      });
      turnIndex++;
    }
  }

  if (events.length === 0) return null;

  // Build metadata
  const primaryModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const totalToolCalls = events.filter((e) => e.track === "tool_call").length;
  const errorCount = events.filter((e) => e.isError).length;
  const duration = events.length > 1 ? events[events.length - 1].t - events[0].t : 0;

  const metadata: SessionMetadata = {
    totalEvents: events.length,
    totalTurns: turns.length,
    totalToolCalls,
    errorCount,
    duration,
    models,
    primaryModel,
    format: "visual-studio",
    customTitle: header.Name || undefined,
    sessionMode: header.SelectedAgent?.Service?.Name?.includes("AgentMode")
      ? "agent"
      : header.SelectedAgent?.Service?.Name?.includes("CopilotCli")
        ? "cli"
        : "chat",
  };

  return { events, turns, metadata };
}
