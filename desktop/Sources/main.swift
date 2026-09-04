import AppKit
import WebKit
import Foundation

final class HarnessApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var child: Process?
    private var launchURL: URL?
    private var titleObservation: NSKeyValueObservation?
    private var stopping = false
    private var childStopInProgress = false
    private var stopCompletions: [() -> Void] = []
    private var generation = 0
    private var uiChecks = 0
    private var verifiedGeneration = -1
    private let support = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ai.deepseek.harness", isDirectory: true)
    private let snapshotPath: String? = {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--smoke-snapshot"), index + 1 < args.count else { return nil }
        return args[index + 1]
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "DeepSeek Harness"
        window.minSize = NSSize(width: 720, height: 500)
        window.center()
        window.setFrameAutosaveName("DeepSeekHarnessMain")
        window.delegate = self
        window.contentView = webView
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            self?.window.title = view.title.flatMap { $0.isEmpty ? nil : $0 } ?? "DeepSeek Harness"
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        startRuntime()
    }

    private func installMenu() {
        let main = NSMenu()
        NSApp.mainMenu = main
        func addMenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }
        let app = addMenu("DeepSeek Harness")
        app.addItem(withTitle: "关于 DeepSeek Harness", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "隐藏 DeepSeek Harness", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "退出 DeepSeek Harness", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = addMenu("文件")
        let browser = file.addItem(withTitle: "在浏览器中打开", action: #selector(openInBrowser), keyEquivalent: "")
        browser.target = self
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = addMenu("编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"),
                                     ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        let view = addMenu("显示")
        let reload = view.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        let windows = addMenu("窗口")
        windows.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windows
    }

    private func showStatus(_ heading: String, detail: String = "") {
        func escape(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
        }
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <title>DeepSeek Harness</title>
        <style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-content:center;height:90vh;margin:0;padding:32px;box-sizing:border-box}h1{font-size:24px;font-weight:600}p{max-width:650px;line-height:1.7;white-space:pre-wrap;opacity:.75}</style>
        <h1>\(escape(heading))</h1><p>\(escape(detail))</p>
        """, baseURL: nil)
    }

    private func log(_ message: String) {
        // Never persist the launch token or model output in the shell log.
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let url = support.appendingPathComponent("native-launcher.log")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        }
    }

    private func startRuntime() {
        generation += 1
        let current = generation
        launchURL = nil
        uiChecks = 0
        showStatus("正在启动 DeepSeek Harness…", detail: "正在等待本地服务提供登录地址。")
        guard let resources = Bundle.main.resourceURL else {
            fail("找不到应用资源目录。")
            return
        }
        let node = resources.appendingPathComponent("resources/node/bin/node")
        let runtime = support.appendingPathComponent("runtime", isDirectory: true)
        let entry = runtime.appendingPathComponent("node_modules/@deepseek-ai/dsh/lib/bin.js")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            fail("找不到已安装的 DSH 或应用内的 Node.js。请检查安装，之后按 ⌘R 重试。")
            return
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [entry.path, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = [node.deletingLastPathComponent().path,
                                runtime.appendingPathComponent("node_modules/.bin").path,
                                "/opt/homebrew/bin", "/usr/local/bin", environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { [weak self] stopped in
            DispatchQueue.main.async {
                guard let self, !self.stopping, self.generation == current else { return }
                self.fail("DSH 服务已退出（状态 \(stopped.terminationStatus)）。按 ⌘R 重试。")
            }
        }
        child = process
        do {
            try process.run()
            log("runtime started pid=\(process.processIdentifier)")
        } catch {
            fail("DSH 启动失败：\(error.localizedDescription)")
            return
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var pending = Data()
            let reader = pipe.fileHandleForReading
            while true {
                let data = reader.availableData
                if data.isEmpty { break }
                pending.append(data)
                while let end = pending.firstIndex(of: 10) {
                    let line = String(decoding: pending[..<end], as: UTF8.self)
                    pending.removeSubrange(...end)
                    guard let url = startupURL(from: line) else { continue }
                    DispatchQueue.main.async { self?.loadRuntime(url, generation: current) }
                }
                if pending.count > 1_048_576 { pending.removeAll() }
            }
            try? reader.close()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            guard let self, self.generation == current, self.launchURL == nil else { return }
            self.fail("DSH 启动超时，尚未输出可用的登录地址。按 ⌘R 重试。")
        }
    }

    private func loadRuntime(_ url: URL, generation current: Int) {
        guard current == generation, launchURL == nil, !stopping else { return }
        launchURL = url
        let hasToken = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "token" }) ?? false
        log("navigation requested port=\(url.port ?? 0) authenticated_url=\(hasToken)")
        // Keep the complete URL: DSH exchanges its token for a signed browser cookie.
        webView.load(URLRequest(url: url))
    }

    private func fail(_ reason: String) {
        log("startup/navigation failure: \(reason)")
        showStatus("DeepSeek Harness 暂时无法启动", detail: reason)
    }

    @objc private func reloadPage() {
        guard !stopping, !childStopInProgress else { return }
        if let child, child.isRunning, let url = launchURL {
            uiChecks = 0
            webView.load(URLRequest(url: url))
        } else {
            generation += 1
            showStatus("正在重新启动 DeepSeek Harness…")
            stopChild { [weak self] in
                guard let self, !self.stopping else { return }
                self.startRuntime()
            }
        }
    }

    private func stopChild(completion: @escaping () -> Void) {
        stopCompletions.append(completion)
        guard !childStopInProgress else { return }
        childStopInProgress = true
        let process = child
        log("shutdown: stopping child")
        if let process, process.isRunning { process.terminate() }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            if let process {
                // DSH gives its asynchronous cleanup up to five seconds.
                let deadline = Date().addingTimeInterval(7)
                while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                self?.log("shutdown: waiting for child exit")
                process.waitUntilExit()
                self?.log("shutdown: child exit observed")
            }
            // NSApplication's terminateLater can run a nested modal loop while
            // the SIGTERM main-queue handler is still active. A second GCD main
            // block cannot run then; schedule through the modal run loop itself.
            RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
                guard let self else { return }
                self.child = nil
                self.childStopInProgress = false
                let callbacks = self.stopCompletions
                self.stopCompletions.removeAll()
                callbacks.forEach { $0() }
            }
            CFRunLoopWakeUp(CFRunLoopGetMain())
        }
    }

    @objc private func openInBrowser() {
        if let url = launchURL { NSWorkspace.shared.open(url) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") else { return nil }
        if url.host == launchURL?.host, url.port == launchURL?.port {
            webView.load(action.request)
        } else {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, action.targetFrame?.isMainFrame == true,
           let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? ""),
           url.host != launchURL?.host || url.port != launchURL?.port {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse {
            log("main document HTTP \(http.statusCode)")
            if http.statusCode >= 400 {
                decisionHandler(.cancel)
                fail("本地服务返回 HTTP \(http.statusCode)。按 ⌘R 重新获取登录会话。")
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.host == "127.0.0.1" else { return }
        verifyRenderedUI(generation)
    }

    private func verifyRenderedUI(_ current: Int) {
        guard current == generation, verifiedGeneration != current, !stopping else { return }
        uiChecks += 1
        webView.evaluateJavaScript("JSON.stringify({buttons:document.querySelectorAll('button').length,editable:document.querySelectorAll('textarea,[contenteditable=true]').length,text:document.body.innerText.length})") { [weak self] result, _ in
            guard let self, self.generation == current, !self.stopping else { return }
            if let raw = result as? String, let data = raw.data(using: .utf8),
               let value = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
               (value["buttons"] ?? 0) >= 3, (value["editable"] ?? 0) >= 1, (value["text"] ?? 0) > 20 {
                self.verifiedGeneration = current
                self.log("native UI ready: \(raw)")
                if let path = self.snapshotPath {
                    let args = CommandLine.arguments
                    if let index = args.firstIndex(of: "--smoke-history-title"), index + 1 < args.count {
                        self.verifyHistory(args[index + 1], path: path, current: current)
                    } else {
                        self.saveSnapshot(path)
                    }
                }
            } else if self.uiChecks < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.verifyRenderedUI(current) }
            } else {
                // A user can already be on a settings or another valid route.
                // Diagnostics must never replace their page or discard a draft.
                self.log("native UI readiness probe did not find the conversation editor")
            }
        }
    }

    // Explicit smoke-test mode only: exercise a real history row in WKWebView.
    // Normal launches never click a row or alter the current selection.
    private func verifyHistory(_ title: String, path: String, current: Int, attempt: Int = 0, stableCount: Int = 0) {
        guard generation == current, !stopping else { return }
        let encoded = String(data: try! JSONSerialization.data(withJSONObject: [title]), encoding: .utf8)!
        let script = """
        (() => {
          const title = \(encoded)[0];
          const row = [...document.querySelectorAll('[role=treeitem]')].find(r => r.textContent.includes(title));
          if (\(attempt) === 0) { if (!row) return 'missing'; row.click(); return 'clicked'; }
          const selected = row && row.getAttribute('aria-selected') === 'true';
          const hasTargetMessage = [...document.querySelectorAll('[class$="_userRow"]')].some(r => r.textContent.includes(title));
          const heading = document.querySelector('nav[aria-label="会话层级"]');
          let visible = !!row && row.getBoundingClientRect().width > 0 && row.getBoundingClientRect().height > 0;
          for (let node = row; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) visible = false;
          }
          return visible && selected && hasTargetMessage && heading?.textContent.includes(title) ? 'ready' : row ? 'waiting' : 'missing';
        })()
        """
        webView.evaluateJavaScript(script) { [weak self] result, error in
            guard let self, self.generation == current, !self.stopping else { return }
            let status = result as? String ?? "script-error"
            if status == "ready", stableCount >= 4 {
                self.log("native history ready: target row, heading and message stable for 2 seconds")
                self.saveSnapshot(path)
            } else if error == nil, status != "missing", attempt < 30 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.verifyHistory(title, path: path, current: current, attempt: attempt + 1,
                                       stableCount: status == "ready" ? stableCount + 1 : 0)
                }
            } else {
                self.log("native history smoke failed: \(status)")
            }
        }
    }

    private func saveSnapshot(_ path: String) {
        webView.takeSnapshot(with: nil) { image, _ in
            if let image, let tiff = image.tiffRepresentation,
               let bitmap = NSBitmapImageRep(data: tiff),
               let png = bitmap.representation(using: .png, properties: [:]) {
                do { try png.write(to: URL(fileURLWithPath: path)); self.log("native UI snapshot saved") }
                catch { self.log("native UI snapshot failed") }
            } else { self.log("native UI snapshot failed") }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("页面加载失败：\(error.localizedDescription)") }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("页面加载失败：\(error.localizedDescription)") }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !stopping else { return .terminateLater }
        log("shutdown requested")
        stopping = true
        generation += 1
        stopChild { [weak self] in
            self?.log("launcher exiting; runtime stopped")
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

let app = NSApplication.shared
if let bundleID = Bundle.main.bundleIdentifier,
   let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
    existing.activate(options: [])
    exit(0)
}
let delegate = HarnessApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
// Terminating the launcher from a test or the OS must also stop its runtime.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSignal = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
termSignal.setEventHandler { app.terminate(nil) }
intSignal.setEventHandler { app.terminate(nil) }
termSignal.resume()
intSignal.resume()
app.run()
