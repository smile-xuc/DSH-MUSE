import AppKit
import WebKit
import Foundation

/// WKWebView subclass backing the dsh-drop-path-ref plugin: a drop of files
/// the composer cannot attach (anything but png/jpg/webp/gif/svg) is turned
/// into absolute-path prompt references instead of the stock "unsupported
/// type" rejection. The override stays strictly conservative — it hands the
/// drop back to the stock flow (super) whenever the plugin has not reported
/// ready, the drop is empty, or every file is a stock-supported image.
final class HarnessWebView: WKWebView {
    /// Set only through the `dshDropPathRef` script message posted by the
    /// client plugin on apply/dispose; false again after each navigation.
    var dropPathRefReady = false
    private static let stockImageExtensions: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "svg"]

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                          options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
            .filter(\.isFileURL)
        guard dropPathRefReady,
              !urls.isEmpty,
              urls.allSatisfy({ !Self.stockImageExtensions.contains($0.pathExtension.lowercased()) }) else {
            return super.performDragOperation(sender)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: urls.map(\.path)),
              let json = String(data: data, encoding: .utf8) else {
            return super.performDragOperation(sender)
        }
        evaluateJavaScript("window.__dshDropPathRef ? window.__dshDropPathRef.insertPaths(\(json)) : false")
        return true
    }
}

/// Relays the dsh-drop-path-ref client plugin's readiness to the web view;
/// drops are intercepted natively only while the plugin reports ready, so an
/// uninstalled plugin silently restores the stock drop behavior.
final class DropPathRefBridge: NSObject, WKScriptMessageHandler {
    weak var webView: HarnessWebView?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dshDropPathRef" else { return }
        webView?.dropPathRefReady = (message.body as? String) == "ready"
    }
}

final class ConsoleBridge: NSObject, WKScriptMessageHandler {
    weak var app: HarnessApp?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dshConsole", let text = message.body as? String else { return }
        app?.log("web: \(text)")
    }
}

final class HarnessApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: HarnessWebView!
    private let dropPathRefBridge = DropPathRefBridge()
    private let consoleBridge = ConsoleBridge()
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
        configuration.userContentController.add(dropPathRefBridge, name: "dshDropPathRef")
        consoleBridge.app = self
        configuration.userContentController.add(consoleBridge, name: "dshConsole")
        let consoleScript = WKUserScript(source: """
        (() => {
          const bridge = (level, ...args) => {
            try {
              const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
              window.webkit?.messageHandlers?.dshConsole?.postMessage(`[${level}] ${msg}`);
            } catch (_) {}
          };
          const _log = console.log, _warn = console.warn, _error = console.error;
          console.log = (...args) => { _log(...args); bridge('LOG', ...args); };
          console.warn = (...args) => { _warn(...args); bridge('WARN', ...args); };
          console.error = (...args) => { _error(...args); bridge('ERROR', ...args); };
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        configuration.userContentController.addUserScript(consoleScript)
        webView = HarnessWebView(frame: .zero, configuration: configuration)
        dropPathRefBridge.webView = webView
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

    fileprivate func log(_ message: String) {
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
        let electronExecutable = Bundle.main.infoDictionary?["DSHElectronExecutable"] as? String
        guard let launch = resolveRuntimeLaunch(resourcesURL: resources, bundleURL: Bundle.main.bundleURL,
                                               applicationSupportURL: support, electronExecutableName: electronExecutable) else {
            fail("找不到已安装的 DSH 运行时。请检查安装，之后按 ⌘R 重试。")
            return
        }
        let process = Process()
        process.executableURL = launch.executableURL
        process.arguments = launch.arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        environment.merge(launch.environment) { _, new in new }
        environment["PATH"] = (launch.pathEntries + [
            "/opt/homebrew/bin", "/usr/local/bin", environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        ]).joined(separator: ":")
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
        /* A fresh page load wipes the plugin's hook; it re-posts "ready". */
        self.webView.dropPathRefReady = false
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
                    let delayIndex = args.firstIndex(of: "--smoke-delay")
                    let delay = (delayIndex != nil && delayIndex! + 1 < args.count) ? (Double(args[delayIndex! + 1]) ?? 0.0) : 0.0
                    if let index = args.firstIndex(of: "--smoke-history-title"), index + 1 < args.count {
                        self.verifyHistory(args[index + 1], path: path, current: current)
                    } else if delay > 0 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                            self.saveSnapshot(path)
                        }
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
          const row = [...document.querySelectorAll('[data-dsh-pins-list] > div, [role=treeitem]')].find(r => r.textContent.includes(title));
          if (!row) return JSON.stringify({ status: 'missing' });
          if (\(attempt) === 0) { row.click(); return JSON.stringify({ status: 'clicked' }); }
          const isPinRow = row.closest('[data-dsh-pins-list]') !== null;
          const selected = row.getAttribute('aria-selected') === 'true' || isPinRow;
          const bodyText = document.body.innerText;
          const hasNotHome = !bodyText.includes('探索未至之境');
          const hasMessages = document.querySelectorAll('[class*="message"], [class*="bubble"], [class*="userRow"]').length > 0;
          return JSON.stringify({
            status: (hasNotHome || hasMessages) ? 'ready' : 'waiting',
            isPinRow,
            hasNotHome,
            hasMessages
          });
        })()
        """
        webView.evaluateJavaScript(script) { [weak self] result, error in
            guard let self, self.generation == current, !self.stopping else { return }
            if attempt == 2 || attempt == 6 {
                let debugPath = (path as NSString).deletingLastPathComponent + "/clicked-debug.png"
                self.saveSnapshot(debugPath)
            }
            var status = "script-error"
            if let raw = result as? String, let data = raw.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let s = obj["status"] as? String {
                status = s
                self.log("verifyHistory attempt \(attempt): \(raw)")
            } else {
                self.log("verifyHistory attempt \(attempt): raw=\(String(describing: result)) error=\(String(describing: error))")
            }
            if status == "ready", stableCount >= 2 {
                self.log("native history ready: session opened and verified")
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
