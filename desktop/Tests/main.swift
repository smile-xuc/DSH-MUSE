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

print("\(urlCases.count + 6 - failures)/\(urlCases.count + 6) launcher tests passed")
exit(failures == 0 ? 0 : 1)
