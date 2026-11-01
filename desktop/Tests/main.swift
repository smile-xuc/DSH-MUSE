import Foundation

let urlCases: [(String, String?)] = [
    ("dsh web: http://127.0.0.1:51342/?token=test_token-123", "http://127.0.0.1:51342/?token=test_token-123"),
    ("dsh web: http://127.0.0.1:3080", "http://127.0.0.1:3080"),
    ("dsh web: http://127.0.0.1:3080/?token=a (LAN: http://192.168.1.2:3080/?token=a)", "http://127.0.0.1:3080/?token=a"),
    ("warning: http://127.0.0.1:3080/?token=a", nil),
    ("dsh web: http://127.0.0.1.example.org:3080/?token=a", nil),
    ("dsh web: http://example.org:3080/?token=a", nil),
    ("dsh web: javascript:alert(1)", nil),
    ("dsh web: http://user:pass@127.0.0.1:3080/?token=a", nil),
    ("dsh web: http://127.0.0.1:0/?token=a", nil),
    ("dsh web: http://127.0.0.1:70000/?token=a", nil),
]

var failures = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        failures += 1
        print("FAIL: \(message)")
        return
    }
}

for (index, item) in urlCases.enumerated() {
    let actual = startupURL(from: item.0)?.absoluteString
    check(actual == item.1, "startup URL case \(index + 1): expected \(item.1 ?? "nil"), got \(actual ?? "nil")")
}

let fileManager = FileManager.default
func makeFile(_ url: URL, executable: Bool = false) throws {
    try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard fileManager.createFile(atPath: url.path, contents: Data()) else { throw CocoaError(.fileWriteUnknown) }
    if executable {
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }
}

func fixtureRoot() throws -> URL {
    let url = fileManager.temporaryDirectory.appendingPathComponent("dsh-runtime-test-\(UUID().uuidString)", isDirectory: true)
    try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

let legacyRoot = try fixtureRoot()
defer { try? fileManager.removeItem(at: legacyRoot) }
let legacyResources = legacyRoot.appendingPathComponent("Contents/Resources", isDirectory: true)
let legacyBundle = legacyRoot.appendingPathComponent("DeepSeek Harness.app", isDirectory: true)
let legacySupport = legacyRoot.appendingPathComponent("support", isDirectory: true)
let legacyNode = legacyResources.appendingPathComponent("resources/node/bin/node")
let legacyEntry = legacySupport.appendingPathComponent("runtime/node_modules/@deepseek-ai/dsh/lib/bin.js")
let embeddedNode = legacyResources.appendingPathComponent("app/node_modules/@deepseek-ai/dsh/lib/bin.js")
let electronExecutable = legacyBundle.appendingPathComponent("Contents/MacOS/DeepSeek Harness")
try makeFile(legacyNode, executable: true)
try makeFile(legacyEntry)
try makeFile(embeddedNode)
try makeFile(electronExecutable, executable: true)

let legacyLaunch = resolveRuntimeLaunch(resourcesURL: legacyResources, bundleURL: legacyBundle,
                                        applicationSupportURL: legacySupport, electronExecutableName: "DeepSeek Harness")
check(legacyLaunch?.executableURL == legacyNode, "legacy runtime should use the standalone Node executable")
check(legacyLaunch?.arguments.first == legacyEntry.path, "legacy runtime should use the external DSH package")
check(legacyLaunch?.environment["ELECTRON_RUN_AS_NODE"] == nil, "legacy runtime should not enable Electron's Node mode")

let bundledRoot = try fixtureRoot()
defer { try? fileManager.removeItem(at: bundledRoot) }
let bundledResources = bundledRoot.appendingPathComponent("Contents/Resources", isDirectory: true)
let bundledApp = bundledRoot.appendingPathComponent("DeepSeek Harness.app", isDirectory: true)
let bundledSupport = bundledRoot.appendingPathComponent("support", isDirectory: true)
let bundledEntry = bundledResources.appendingPathComponent("app/node_modules/@deepseek-ai/dsh/lib/bin.js")
let bundledElectron = bundledApp.appendingPathComponent("Contents/MacOS/DeepSeek Harness")
try makeFile(bundledEntry)
try makeFile(bundledElectron, executable: true)

let bundledLaunch = resolveRuntimeLaunch(resourcesURL: bundledResources, bundleURL: bundledApp,
                                         applicationSupportURL: bundledSupport, electronExecutableName: "DeepSeek Harness")
check(bundledLaunch?.executableURL == bundledElectron, "bundled runtime should use the original Electron executable")
check(bundledLaunch?.arguments == ["--expose-internals", bundledEntry.path, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
      "bundled runtime should launch the DSH web CLI through Electron")
check(bundledLaunch?.environment["ELECTRON_RUN_AS_NODE"] == "1", "bundled runtime should enable Electron's Node mode")

// --- Parent-death watchdog & stale runtime reaper tests ---
let lifecycleSupport = try fixtureRoot()
defer { try? fileManager.removeItem(at: lifecycleSupport) }

let watchdogURL = try ensureParentWatchdogScript(in: lifecycleSupport)
check(fileManager.fileExists(atPath: watchdogURL.path), "watchdog script should be written to support directory")

let nodeCandidates = [
    "/Applications/DeepSeek Harness.app/Contents/Resources/resources/node/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
]
if let nodePath = nodeCandidates.first(where: { fileManager.isExecutableFile(atPath: $0) }) {
    // 1. Verify env and execArgv scrubbing inside guarded runtime
    let probePipe = Pipe()
    let probeStdin = Pipe()
    let probe = Process()
    probe.executableURL = URL(fileURLWithPath: nodePath)
    probe.arguments = [
        "--require", watchdogURL.path,
        "-e",
        "console.log(JSON.stringify({ envSet: Boolean(process.env.DSH_NATIVE_LAUNCHER_PID), hasArg: process.execArgv.some(a => a.endsWith('parent-watchdog.cjs')) })); process.exit(0);",
    ]
    var probeEnv = ProcessInfo.processInfo.environment
    probeEnv["DSH_NATIVE_LAUNCHER_PID"] = String(ProcessInfo.processInfo.processIdentifier)
    probe.environment = probeEnv
    probe.standardInput = probeStdin
    probe.standardOutput = probePipe
    try probe.run()
    probe.waitUntilExit()
    let probeOut = String(decoding: probePipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    try? probeStdin.fileHandleForWriting.close()
    check(probeOut == "{\"envSet\":false,\"hasArg\":false}", "watchdog should scrub DSH_NATIVE_LAUNCHER_PID and execArgv: got \(probeOut)")

    // 2. Verify child runtime exits automatically when its parent launcher dies via SIGKILL
    let pidFile = lifecycleSupport.appendingPathComponent("child.pid")
    let parentLauncher = Process()
    parentLauncher.executableURL = URL(fileURLWithPath: nodePath)
    parentLauncher.arguments = [
        "-e",
        """
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, [
          '--require', process.argv[1],
          '-e', 'process.on("SIGTERM", () => process.exit(0)); console.log("READY"); setInterval(() => {}, 10000);'
        ], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, DSH_NATIVE_LAUNCHER_PID: String(process.pid) }
        });
        child.stdout.once('data', () => {
          writeFileSync(process.argv[2], String(child.pid));
        });
        setInterval(() => {}, 10000);
        """,
        watchdogURL.path,
        pidFile.path,
    ]
    try parentLauncher.run()
    var spawnedChildPID: pid_t = 0
    let spawnDeadline = Date().addingTimeInterval(5)
    while Date() < spawnDeadline {
        if let raw = try? String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let parsed = pid_t(raw), parsed > 0 {
            spawnedChildPID = parsed
            break
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    check(spawnedChildPID > 0, "simulated parent launcher should spawn guarded child runtime")
    // Force-kill parent launcher with SIGKILL (simulating Force Quit / crash / timeout kill)
    kill(parentLauncher.processIdentifier, SIGKILL)
    parentLauncher.waitUntilExit()

    var childExited = false
    let exitDeadline = Date().addingTimeInterval(3.0)
    while Date() < exitDeadline {
        if kill(spawnedChildPID, 0) != 0 {
            childExited = true
            break
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    if !childExited && spawnedChildPID > 0 {
        kill(spawnedChildPID, SIGKILL)
    }
    check(childExited, "guarded child runtime must exit automatically when launcher dies with SIGKILL")

    // 3. Verify stale runtime.pid reaper terminates matching runtime and ignores mismatched executables
    let sleeper = Process()
    sleeper.executableURL = URL(fileURLWithPath: nodePath)
    sleeper.arguments = ["-e", "setInterval(() => {}, 10000)"]
    try sleeper.run()
    let sleeperPID = sleeper.processIdentifier

    // Mismatched executable path must NOT kill the process
    recordRuntimePID(sleeperPID, launcherPID: 1, executablePath: "/nonexistent/other-binary", in: lifecycleSupport)
    reapStaleRuntime(in: lifecycleSupport)
    check(kill(sleeperPID, 0) == 0, "reaper must not terminate a PID whose executable path does not match")

    // Live foreign launcher PID must NOT kill the process
    let liveParent = Process()
    liveParent.executableURL = URL(fileURLWithPath: nodePath)
    liveParent.arguments = ["-e", "setInterval(() => {}, 10000)"]
    try liveParent.run()
    recordRuntimePID(sleeperPID, launcherPID: liveParent.processIdentifier, executablePath: nodePath, in: lifecycleSupport)
    reapStaleRuntime(in: lifecycleSupport)
    check(kill(sleeperPID, 0) == 0, "reaper must not terminate a runtime owned by a still-running launcher")
    kill(liveParent.processIdentifier, SIGTERM)
    liveParent.waitUntilExit()

    // Orphaned runtime (dead launcherPID) with matching executable path MUST be terminated
    recordRuntimePID(sleeperPID, launcherPID: liveParent.processIdentifier, executablePath: nodePath, in: lifecycleSupport)
    reapStaleRuntime(in: lifecycleSupport)
    sleeper.waitUntilExit()
    var sleeperGone = false
    let reaperDeadline = Date().addingTimeInterval(2.0)
    while Date() < reaperDeadline {
        if kill(sleeperPID, 0) != 0 {
            sleeperGone = true
            break
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    check(sleeperGone, "reaper should terminate recorded stale runtime process")
    check(!fileManager.fileExists(atPath: runtimePIDFileURL(in: lifecycleSupport).path),
          "reaper should remove runtime.pid after cleanup")
}

let totalChecks = urlCases.count + 14
print("\(totalChecks - failures)/\(totalChecks) launcher tests passed")
exit(failures == 0 ? 0 : 1)
