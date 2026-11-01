import Darwin
import Foundation

private let parentWatchdogScript = """
'use strict';
const { isMainThread } = require('node:worker_threads');
const { realpathSync } = require('node:fs');
const expectedLauncherPid = Number(process.env.DSH_NATIVE_LAUNCHER_PID || 0);
if (isMainThread && !process.channel && expectedLauncherPid > 0 && process.ppid === expectedLauncherPid) {
  delete process.env.DSH_NATIVE_LAUNCHER_PID;
  let selfReal = __filename;
  try { selfReal = realpathSync(__filename); } catch {}
  const matchesSelf = (candidate) => {
    if (typeof candidate !== 'string') return false;
    if (candidate === __filename || candidate === selfReal) return true;
    try { return realpathSync(candidate) === selfReal; } catch { return false; }
  };
  for (let i = process.execArgv.length - 1; i >= 0; i -= 1) {
    if (process.execArgv[i - 1] === '--require' && matchesSelf(process.execArgv[i])) {
      process.execArgv.splice(i - 1, 2);
    } else if (process.execArgv[i].startsWith('--require=') && matchesSelf(process.execArgv[i].slice(10))) {
      process.execArgv.splice(i, 1);
    }
  }
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    try { process.stdin.pause(); } catch {}
    if (process.listenerCount('SIGTERM') > 0) {
      try { process.kill(process.pid, 'SIGTERM'); } catch {}
      setTimeout(() => process.exit(0), 5000).unref();
    } else {
      process.exit(0);
    }
  };
  if (process.stdin && typeof process.stdin.on === 'function') {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
  }
  const timer = setInterval(() => {
    if (process.ppid !== expectedLauncherPid) shutdown();
  }, 500);
  timer.unref();
}
"""

func runtimePIDFileURL(in applicationSupportURL: URL) -> URL {
    applicationSupportURL.appendingPathComponent("runtime.pid")
}

func ensureParentWatchdogScript(in applicationSupportURL: URL) throws -> URL {
    let fm = FileManager.default
    try fm.createDirectory(at: applicationSupportURL, withIntermediateDirectories: true)
    let url = applicationSupportURL.appendingPathComponent("parent-watchdog.cjs")
    let data = Data(parentWatchdogScript.utf8)
    if (try? Data(contentsOf: url)) != data {
        try data.write(to: url, options: .atomic)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    return url
}

private func canonicalFilePath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
}

func runningExecutablePath(for pid: pid_t) -> String? {
    guard pid > 0 else { return nil }
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return String(cString: buffer)
}

func recordRuntimePID(_ pid: pid_t, launcherPID: pid_t = ProcessInfo.processInfo.processIdentifier,
                      executablePath: String, in applicationSupportURL: URL) {
    guard pid > 0 else { return }
    let fm = FileManager.default
    try? fm.createDirectory(at: applicationSupportURL, withIntermediateDirectories: true)
    let payload: [String: Any] = [
        "pid": Int(pid),
        "launcherPid": Int(launcherPID),
        "executable": canonicalFilePath(executablePath),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    let url = runtimePIDFileURL(in: applicationSupportURL)
    try? data.write(to: url, options: .atomic)
    try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

func clearRuntimePID(expectedPID: pid_t? = nil, in applicationSupportURL: URL) {
    let url = runtimePIDFileURL(in: applicationSupportURL)
    if let expectedPID {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let recorded = obj["pid"] as? Int,
              pid_t(recorded) == expectedPID else { return }
    }
    try? FileManager.default.removeItem(at: url)
}

@discardableResult
func reapStaleRuntime(in applicationSupportURL: URL) -> pid_t? {
    let url = runtimePIDFileURL(in: applicationSupportURL)
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rawPID = obj["pid"] as? Int,
          rawPID > 1,
          let expectedExec = obj["executable"] as? String else {
        try? FileManager.default.removeItem(at: url)
        return nil
    }
    // Never terminate a runtime whose owning launcher is still alive (other than self restarting).
    if let rawLauncher = obj["launcherPid"] as? Int,
       rawLauncher > 1,
       pid_t(rawLauncher) != ProcessInfo.processInfo.processIdentifier,
       kill(pid_t(rawLauncher), 0) == 0 {
        return nil
    }
    let pid = pid_t(rawPID)
    guard kill(pid, 0) == 0,
          let liveExec = runningExecutablePath(for: pid),
          canonicalFilePath(liveExec) == canonicalFilePath(expectedExec) else {
        try? FileManager.default.removeItem(at: url)
        return nil
    }
    _ = kill(pid, SIGTERM)
    let deadline = Date().addingTimeInterval(3.0)
    while kill(pid, 0) == 0 && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
    }
    if kill(pid, 0) == 0 {
        _ = kill(pid, SIGKILL)
        let killDeadline = Date().addingTimeInterval(1.0)
        while kill(pid, 0) == 0 && Date() < killDeadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
    }
    try? FileManager.default.removeItem(at: url)
    return pid
}
