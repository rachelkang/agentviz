import { describe, it, expect } from "vitest";
import { detectVisualStudio, parseVisualStudioJSON, parseVisualStudioFromDecoded } from "../lib/vsParser";
import { detectFormat, parseSession } from "../lib/parseSession";

// Build a minimal VS session JSON envelope for testing
function makeEnvelope(overrides) {
  return {
    _format: "visual-studio",
    version: 1,
    header: {
      Name: "Test Session",
      User: { Name: "testuser" },
      TimeCreated: "2026-03-20T10:00:00.000Z",
      TimeUpdated: "2026-03-20T10:05:00.000Z",
      Id: ["session-001", { Id: "Microsoft.VisualStudio.Conversations" }],
      SelectedAgent: {
        Name: "GitHub Copilot",
        Service: { Name: "Microsoft.VisualStudio.Copilot.AgentModeResponder", Version: "0.3" },
      },
      Responders: [],
      ConversationMode: "Default",
    },
    messages: [
      {
        "0": 0,
        "1": {
          Content: [[3, { Content: "Create a hello world app" }]],
          Model: "claude-sonnet-4.5",
        },
      },
      {
        "0": 1,
        "1": {
          Content: [
            [10, { Content: "Let me create that for you.", ReasoningTokenCount: 128 }],
            [7, {
              Function: { Id: ["call_001"], Name: "run_command_in_terminal", Arguments: [0, { json: '{"command":"echo hello"}' }] },
              Result: [0, { Value: { ValueContainer: ["System.String", "Command executed"] } }],
              Status: 1,
            }],
            [3, { Content: "Done! I created a hello world app." }],
          ],
          Model: [0, { Id: "claude-sonnet-4.5", Name: "claude-sonnet-4.5", DisplayName: "Claude Sonnet 4.5" }],
          Author: { Name: "GitHub Copilot" },
          Status: 1,
        },
      },
    ],
    ...overrides,
  };
}

describe("vsParser", function () {
  describe("detectVisualStudio", function () {
    it("detects valid VS session envelope", function () {
      var text = JSON.stringify(makeEnvelope());
      expect(detectVisualStudio(text)).toBe(true);
    });

    it("rejects non-VS JSON", function () {
      expect(detectVisualStudio('{"version":3,"requests":[],"sessionId":"x"}')).toBe(false);
    });

    it("rejects JSONL", function () {
      expect(detectVisualStudio('{"type":"session.start","data":{}}')).toBe(false);
    });

    it("rejects plain text", function () {
      expect(detectVisualStudio("hello world")).toBe(false);
    });

    it("rejects missing _format", function () {
      var env = makeEnvelope();
      delete env._format;
      expect(detectVisualStudio(JSON.stringify(env))).toBe(false);
    });
  });

  describe("detectFormat integration", function () {
    it("returns visual-studio for VS envelope", function () {
      expect(detectFormat(JSON.stringify(makeEnvelope()))).toBe("visual-studio");
    });
  });

  describe("parseVisualStudioJSON", function () {
    it("parses a basic session with user and assistant messages", function () {
      var text = JSON.stringify(makeEnvelope());
      var result = parseVisualStudioJSON(text);
      expect(result).not.toBeNull();
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.turns.length).toBe(1);
      expect(result.metadata.format).toBe("visual-studio");
    });

    it("extracts user message text", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      var userEvent = result.events.find(function (e) { return e.agent === "user"; });
      expect(userEvent).toBeDefined();
      expect(userEvent.text).toBe("Create a hello world app");
    });

    it("extracts reasoning events", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      var reasoning = result.events.find(function (e) { return e.track === "reasoning"; });
      expect(reasoning).toBeDefined();
      expect(reasoning.text).toBe("Let me create that for you.");
      expect(reasoning.tokenUsage).toEqual({ outputTokens: 128 });
    });

    it("extracts tool calls", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      var toolCall = result.events.find(function (e) { return e.track === "tool_call"; });
      expect(toolCall).toBeDefined();
      expect(toolCall.toolName).toBe("run_command_in_terminal");
      expect(toolCall.toolInput).toEqual({ command: "echo hello" });
    });

    it("extracts assistant text output", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      var output = result.events.find(function (e) { return e.track === "output"; });
      expect(output).toBeDefined();
      expect(output.text).toBe("Done! I created a hello world app.");
    });

    it("tracks models in metadata", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      expect(result.metadata.models).toHaveProperty("claude-sonnet-4.5");
      expect(result.metadata.primaryModel).toBe("claude-sonnet-4.5");
    });

    it("sets format to visual-studio", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      expect(result.metadata.format).toBe("visual-studio");
    });

    it("sets sessionMode to agent for AgentModeResponder", function () {
      var result = parseVisualStudioJSON(JSON.stringify(makeEnvelope()));
      expect(result.metadata.sessionMode).toBe("agent");
    });

    it("returns null for empty messages", function () {
      var env = makeEnvelope({ messages: [] });
      expect(parseVisualStudioJSON(JSON.stringify(env))).toBeNull();
    });

    it("returns null for invalid JSON", function () {
      expect(parseVisualStudioJSON("not json")).toBeNull();
    });

    it("returns null for non-VS envelope", function () {
      expect(parseVisualStudioJSON('{"foo":"bar"}')).toBeNull();
    });
  });

  describe("multi-turn session", function () {
    it("creates separate turns for each user message", function () {
      var env = makeEnvelope({
        messages: [
          { "0": 0, "1": { Content: [[3, { Content: "First question" }]], Model: "gpt-5-mini" } },
          { "0": 1, "1": { Content: [[3, { Content: "First answer" }]], Author: { Name: "Copilot" }, Status: 1 } },
          { "0": 0, "1": { Content: [[3, { Content: "Second question" }]], Model: "gpt-5-mini" } },
          { "0": 1, "1": { Content: [[3, { Content: "Second answer" }]], Author: { Name: "Copilot" }, Status: 1 } },
        ],
      });
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(result.turns.length).toBe(2);
      expect(result.turns[0].userMessage).toBe("First question");
      expect(result.turns[1].userMessage).toBe("Second question");
    });

    it("tracks multiple models", function () {
      var env = makeEnvelope({
        messages: [
          { "0": 0, "1": { Content: [[3, { Content: "Q1" }]], Model: "claude-sonnet-4.5" } },
          { "0": 1, "1": { Content: [[3, { Content: "A1" }]], Model: "claude-sonnet-4.5", Author: { Name: "Copilot" } } },
          { "0": 0, "1": { Content: [[3, { Content: "Q2" }]], Model: "gpt-5-mini" } },
          { "0": 1, "1": { Content: [[3, { Content: "A2" }]], Model: "gpt-5-mini", Author: { Name: "Copilot" } } },
        ],
      });
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(Object.keys(result.metadata.models).length).toBe(2);
      expect(result.metadata.models["claude-sonnet-4.5"]).toBeDefined();
      expect(result.metadata.models["gpt-5-mini"]).toBeDefined();
    });
  });

  describe("parseSession integration", function () {
    it("routes VS envelope through parseSession", function () {
      var text = JSON.stringify(makeEnvelope());
      var result = parseSession(text);
      expect(result).not.toBeNull();
      expect(result.metadata.format).toBe("visual-studio");
    });
  });

  describe("parseVisualStudioFromDecoded", function () {
    it("parses from decoded MessagePack items", function () {
      var env = makeEnvelope();
      var items = [env.version, env.header, ...env.messages];
      var result = parseVisualStudioFromDecoded(items);
      expect(result).not.toBeNull();
      expect(result.turns.length).toBe(1);
      expect(result.metadata.format).toBe("visual-studio");
    });

    it("returns null for too few items", function () {
      expect(parseVisualStudioFromDecoded([1])).toBeNull();
    });
  });

  describe("tool result extraction", function () {
    it("handles string results directly", function () {
      var env = makeEnvelope({
        messages: [
          { "0": 0, "1": { Content: [[3, { Content: "run something" }]], Model: "gpt-5-mini" } },
          { "0": 1, "1": {
            Content: [[7, {
              Function: { Id: ["call_x"], Name: "test_tool", Arguments: [0, { json: '{"a":1}' }] },
              Result: [0, { Value: { ValueContainer: ["System.String", "direct string result"] } }],
              Status: 1,
            }], [3, { Content: "Done" }]],
            Author: { Name: "Copilot" },
          }},
        ],
      });
      var result = parseVisualStudioJSON(JSON.stringify(env));
      var toolCall = result.events.find(function (e) { return e.track === "tool_call"; });
      expect(toolCall.text).toBe("direct string result");
    });
  });

  describe("edge cases", function () {
    it("handles user message without matching response", function () {
      var env = makeEnvelope({
        messages: [
          { "0": 0, "1": { Content: [[3, { Content: "orphan question" }]], Model: "gpt-5-mini" } },
        ],
      });
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(result).not.toBeNull();
      expect(result.turns.length).toBe(1);
      expect(result.events.length).toBe(1);
    });

    it("handles response with no text content", function () {
      var env = makeEnvelope({
        messages: [
          { "0": 0, "1": { Content: [[3, { Content: "Q" }]], Model: "gpt-5-mini" } },
          { "0": 1, "1": { Content: [[10, { ReasoningTokenCount: 50 }]], Author: { Name: "Copilot" } } },
        ],
      });
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(result).not.toBeNull();
      expect(result.turns.length).toBe(1);
    });

    it("handles null Content in message body", function () {
      var env = makeEnvelope({
        messages: [
          { "0": 0, "1": { Content: null, Model: "gpt-5-mini" } },
        ],
      });
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(result).toBeNull();
    });

    it("detects CLI session mode", function () {
      var env = makeEnvelope();
      env.header.SelectedAgent.Service.Name = "Microsoft.VisualStudio.Copilot.CopilotCliResponder";
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(result.metadata.sessionMode).toBe("cli");
    });

    it("detects chat session mode", function () {
      var env = makeEnvelope();
      env.header.SelectedAgent.Service.Name = "Microsoft.VisualStudio.Copilot.CopilotChatAgentProvider";
      var result = parseVisualStudioJSON(JSON.stringify(env));
      expect(result.metadata.sessionMode).toBe("chat");
    });
  });
});
