import { StringDecoder } from "node:string_decoder";

const MARKER = "[REDACTED]";

/** Exact-value masking, compiled once per snapshot; retain rotated values for this session. */
export class Redactor {
  private values = new Set<string>();
  private pattern?: RegExp;
  private maxLength = 0;

  add(values: string[]): void {
    let changed = false;
    for (const value of values) {
      if (value && !this.values.has(value)) {
        this.values.add(value);
        this.maxLength = Math.max(this.maxLength, value.length);
        changed = true;
      }
    }
    if (!changed) return;
    const escaped = [...this.values].sort((a, b) => b.length - a.length)
      .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.pattern = new RegExp(escaped.join("|"), "g");
  }

  text(text: string): string { return this.pattern ? text.replace(this.pattern, () => MARKER) : text; }

  /** Preserve SDK discriminators and image bytes; only text content is a redaction target. */
  content<T extends { type: string; text?: string }>(content: T[]): T[] {
    return content.map(block => block.type === "text" && typeof block.text === "string"
      ? { ...block, text: this.text(block.text) } : block);
  }

  /** Scrub arbitrary data strings/keys, preserving explicitly named root schema fields. */
  value<T>(value: T, rootKeys: ReadonlySet<string> = new Set()): T {
    if (!this.pattern) return value;
    const seen = new WeakMap<object, unknown>();
    const visit = (item: unknown, root = false): unknown => {
      if (typeof item === "string") return this.text(item);
      if (item === null || typeof item !== "object") return item;
      // Tool payloads are JSON-like. Leave opaque SDK instances alone.
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null) return item;
      const existing = seen.get(item);
      if (existing) return existing;
      if (Array.isArray(item)) {
        const copy: unknown[] = [];
        seen.set(item, copy);
        for (const field of item) copy.push(visit(field));
        return copy;
      }
      const copy = Object.create(null) as Record<string, unknown>;
      seen.set(item, copy);
      for (const [key, field] of Object.entries(item)) {
        const masked = root && rootKeys.has(key) ? key : this.text(key);
        let safeKey = masked;
        let suffix = 1;
        while (Object.hasOwn(copy, safeKey)) safeKey = `${masked}#${suffix++}`;
        copy[safeKey] = visit(field);
      }
      return copy;
    };
    return visit(value, true) as T;
  }

  /** Hold only a possible suffix so secrets split across UTF-8 chunks never reach the sink. */
  stream(emit: (data: Buffer) => void): { write(data: Buffer): void; end(): void } {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const flush = (final: boolean) => {
      let cut = final ? pending.length : Math.max(0, pending.length - this.maxLength + 1);
      // A decoded UTF-8 chunk can still be cut between UTF-16 surrogate code units.
      if (cut < pending.length && /[\uD800-\uDBFF]/.test(pending[cut - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(pending[cut] ?? "")) cut--;
      if (!cut) return;
      if (this.pattern) {
        this.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = this.pattern.exec(pending)) && match.index < cut) {
          cut = Math.max(cut, match.index + match[0].length);
        }
        this.pattern.lastIndex = 0;
      }
      const safe = this.text(pending.slice(0, cut));
      pending = pending.slice(cut);
      if (safe) emit(Buffer.from(safe));
    };
    return {
      write: data => { pending += decoder.write(data); flush(false); },
      end: () => { pending += decoder.end(); flush(true); },
    };
  }
}
