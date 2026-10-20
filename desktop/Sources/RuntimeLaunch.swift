import Foundation

struct RuntimeLaunchSpec {
    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]
    let pathEntries: [String]
}

func resolveRuntimeLaunch(resourcesURL: URL, bundleURL: URL, applicationSupportURL: URL,
                          electronExecutableName: String?) -> RuntimeLaunchSpec? {
    let fileManager = FileManager.default
    let runtime = applicationSupportURL.appendingPathComponent("runtime", isDirectory: true)
    let standaloneNode = resourcesURL.appendingPathComponent("resources/node/bin/node")
    let standaloneEntry = runtime.appendingPathComponent("node_modules/@deepseek-ai/dsh/lib/bin.js")
    if fileManager.isExecutableFile(atPath: standaloneNode.path),
       fileManager.fileExists(atPath: standaloneEntry.path) {
        return RuntimeLaunchSpec(
            executableURL: standaloneNode,
            arguments: [standaloneEntry.path, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
            environment: [:],
            pathEntries: [
                standaloneNode.deletingLastPathComponent().path,
                runtime.appendingPathComponent("node_modules/.bin").path,
            ]
        )
    }

    guard let electronExecutableName,
          !electronExecutableName.isEmpty,
          URL(fileURLWithPath: electronExecutableName).lastPathComponent == electronExecutableName else { return nil }
    let electronExecutable = bundleURL.appendingPathComponent("Contents/MacOS/\(electronExecutableName)")
    let bundledEntry = resourcesURL.appendingPathComponent("app/node_modules/@deepseek-ai/dsh/lib/bin.js")
    guard fileManager.isExecutableFile(atPath: electronExecutable.path),
          fileManager.fileExists(atPath: bundledEntry.path) else { return nil }

    return RuntimeLaunchSpec(
        executableURL: electronExecutable,
        arguments: ["--expose-internals", bundledEntry.path, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"],
        environment: ["ELECTRON_RUN_AS_NODE": "1"],
        pathEntries: [resourcesURL.appendingPathComponent("app/node_modules/.bin").path]
    )
}
