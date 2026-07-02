type LogLevel = "info" | "warning" | "error";

type NotifyFn = (message: string, level: LogLevel) => void;

let _notify: NotifyFn | null = null;
const _buffer: Array<{ message: string; level: LogLevel }> = [];

export function setNotifier(fn: NotifyFn | null): void {
  _notify = fn;
  if (fn && _buffer.length > 0) {
    for (const entry of _buffer) {
      fn(entry.message, entry.level);
    }
    _buffer.length = 0;
  }
}

export function logInfo(message: string): void {
  if (_notify) _notify(message, "info");
  else _buffer.push({ message, level: "info" });
}

export function logWarn(message: string): void {
  if (_notify) _notify(message, "warning");
  else _buffer.push({ message, level: "warning" });
}

export function logError(message: string): void {
  if (_notify) _notify(message, "error");
  else _buffer.push({ message, level: "error" });
}
