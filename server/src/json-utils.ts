export function stripJsonFence(text: string): string {
  return String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function extractJsonText(text: string): string {
  const value = stripJsonFence(text);
  const balanced = firstBalancedJson(value, "{", "}");
  if (balanced) return balanced;
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : value;
}

export function extractJsonArrayText(text: string): string {
  const value = stripJsonFence(text);
  const balanced = firstBalancedJson(value, "[", "]");
  if (balanced) return balanced;
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  return start >= 0 && end > start ? value.slice(start, end + 1) : value;
}

export function isJsonReviewText(text: string): boolean {
  try {
    const payload = JSON.parse(extractJsonText(text)) as { dimensions?: unknown; overall?: unknown };
    return Boolean(payload && Array.isArray(payload.dimensions) && "overall" in payload);
  } catch {
    return false;
  }
}

export function isJsonArrayText(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(extractJsonArrayText(text)));
  } catch {
    return false;
  }
}

function firstBalancedJson(text: string, open: "{" | "[", close: "}" | "]"): string | null {
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === open) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
