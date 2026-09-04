import Foundation

let cases: [(String, String?)] = [
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
for (index, item) in cases.enumerated() {
    let actual = startupURL(from: item.0)?.absoluteString
    if actual != item.1 {
        failures += 1
        print("FAIL case \(index + 1): expected \(item.1 ?? "nil"), got \(actual ?? "nil")")
    }
}
print("\(cases.count - failures)/\(cases.count) startup URL tests passed")
exit(failures == 0 ? 0 : 1)
