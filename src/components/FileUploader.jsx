import { useState, useRef } from "react";
import { theme, alpha } from "../lib/theme.js";
import Icon from "./Icon.jsx";

/**
 * Check if a file is likely binary (MessagePack) by examining the first bytes.
 * VS Copilot sessions start with MessagePack: version int (0x01) + fixmap (0x8x).
 */
function looksLikeMsgpack(buf) {
  if (buf.byteLength < 3) return false;
  var view = new Uint8Array(buf);
  // First value is a small positive int (version 1-9)
  if (view[0] >= 1 && view[0] <= 9) {
    // Second value should be a fixmap (0x80-0x8f) or map16 (0xde) or map32 (0xdf)
    var b1 = view[1];
    return (b1 >= 0x80 && b1 <= 0x8f) || b1 === 0xde || b1 === 0xdf;
  }
  return false;
}

export default function FileUploader({ onLoad }) {
  var ref = useRef(null);
  var [over, setOver] = useState(false);

  var [readError, setReadError] = useState(null);

  function handleFile(file) {
    if (!file) return;
    setReadError(null);

    // First read a small header to check if it's binary (MessagePack)
    var headerReader = new FileReader();
    headerReader.onload = function (e) {
      if (looksLikeMsgpack(e.target.result)) {
        // Binary MessagePack: decode with @msgpack/msgpack and wrap as JSON
        var fullReader = new FileReader();
        fullReader.onload = function (fe) {
          import("@msgpack/msgpack").then(function (msgpack) {
            try {
              var buf = new Uint8Array(fe.target.result);
              var items = [];
              for (var val of msgpack.decodeMulti(buf)) {
                items.push(val);
                if (items.length >= 1000) break;
              }
              if (items.length < 2) {
                setReadError("Invalid Visual Studio session file");
                return;
              }
              var envelope = {
                _format: "visual-studio",
                version: items[0],
                header: items[1],
                messages: items.slice(2),
              };
              onLoad(JSON.stringify(envelope), file.name);
            } catch (err) {
              setReadError("Failed to decode binary session: " + err.message);
            }
          }).catch(function (err) {
            setReadError("MessagePack decoder not available: " + err.message);
          });
        };
        fullReader.onerror = function () { setReadError("Could not read file: " + file.name); };
        fullReader.readAsArrayBuffer(file);
      } else {
        // Text-based session: read as text
        var textReader = new FileReader();
        textReader.onload = function (te) { onLoad(te.target.result, file.name); };
        textReader.onerror = function () { setReadError("Could not read file: " + file.name); };
        textReader.readAsText(file);
      }
    };
    headerReader.onerror = function () { setReadError("Could not read file: " + file.name); };
    headerReader.readAsArrayBuffer(file.slice(0, 16));
  }

  return (
    <div
      onDragOver={function (e) { e.preventDefault(); setOver(true); }}
      onDragLeave={function () { setOver(false); }}
      onDrop={function (e) { e.preventDefault(); setOver(false); handleFile(e.dataTransfer.files[0]); }}
      onClick={function () { ref.current && ref.current.click(); }}
      style={{
        border: "2px dashed " + (over ? theme.accent.primary : theme.border.strong),
        borderRadius: theme.radius.xxl, padding: "48px 32px", textAlign: "center",
        cursor: "pointer", background: over ? alpha(theme.accent.primary, 0.03) : theme.bg.surface,
        transition: "background " + theme.transition.smooth + ", border-color " + theme.transition.smooth, maxWidth: 560, margin: "0 auto",
      }}
    >
      <input
        ref={ref} type="file" accept=".jsonl,.json,.txt,.msgpack"
        style={{ display: "none" }}
        onChange={function (e) { handleFile(e.target.files[0]); }}
      />
      <div style={{
        fontSize: theme.fontSize.hero, marginBottom: 12, color: theme.accent.primary,
        transition: "transform " + theme.transition.smooth,
        transform: over ? "scale(1.1)" : "scale(1)",
      }}><Icon name="upload" size={32} /></div>
      <div style={{ fontSize: theme.fontSize.xl, color: theme.text.primary, marginBottom: 8, fontWeight: 600 }}>
        Drop a session file here
      </div>
      <div style={{ fontSize: theme.fontSize.md, color: theme.text.muted, lineHeight: 1.8 }}>
        Claude Code, VS Code, Visual Studio, and Copilot CLI sessions
        <br />
        <span style={{ color: theme.text.dim, fontSize: theme.fontSize.base }}>
          Also accepts .json and .txt
        </span>
      </div>
      {readError && (
        <div style={{ marginTop: 12, fontSize: theme.fontSize.base, color: theme.semantic.error }}>
          {readError}
        </div>
      )}
    </div>
  );
}
