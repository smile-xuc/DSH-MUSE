import Foundation

// The launch URL is an authentication handoff, not a URL to reconstruct.
func startupURL(from line: String) -> URL? {
    let prefix = "dsh web: "
    guard line.hasPrefix(prefix),
          let raw = line.dropFirst(prefix.count).split(whereSeparator: { $0.isWhitespace }).first,
          let parts = URLComponents(string: String(raw)),
          parts.scheme == "http", parts.host == "127.0.0.1",
          parts.user == nil, parts.password == nil,
          let port = parts.port, (1...65535).contains(port),
          parts.path.isEmpty || parts.path == "/" else { return nil }
    return parts.url
}
