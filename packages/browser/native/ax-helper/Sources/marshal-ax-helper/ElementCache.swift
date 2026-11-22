import ApplicationServices

/// Stable string handles into `AXUIElement`s produced by the last snapshot.
/// Replaced wholesale on every `snapshot` call - handles from a previous
/// snapshot are invalid once a new one is taken.
final class ElementCache {
  private var byId: [String: AXUIElement] = [:]
  private var counter = 0

  func reset() {
    byId.removeAll(keepingCapacity: true)
    counter = 0
  }

  func register(_ element: AXUIElement) -> String {
    counter += 1
    let id = "n\(counter)"
    byId[id] = element
    return id
  }

  func resolve(_ id: String) -> AXUIElement? {
    byId[id]
  }
}
