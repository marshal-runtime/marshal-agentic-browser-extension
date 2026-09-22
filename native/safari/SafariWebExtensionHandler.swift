import Foundation
import SafariServices

/// Native app-extension entry point generated Safari Web Extension projects use.
///
/// This handler is intentionally a narrow handshake endpoint. The containing
/// Marshal app owns the KeyVault and browser-instance routing; this extension
/// handler does not store credentials and does not log native message payloads.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let responseStore = UserDefaults(suiteName: "group.com.marshal.agentic-browser")

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let userInfo = item.userInfo,
              let payload = userInfo[SFExtensionMessageKey] as? [String: Any] else {
            context.completeRequest(returningItems: nil)
            return
        }

        let response = NSExtensionItem()
        if payload["kind"] as? String == "marshal.safari.handshake" {
            let responsePayload: [String: Any] = [
                "kind": "marshal.safari.handshake.ack",
                "accepted": true,
                "browser": "safari"
            ]
            response.userInfo = [SFExtensionMessageKey: responsePayload]
        } else if payload["kind"] as? String == "marshal.keyvault.typeSecret",
                  let requestId = payload["requestId"] as? String,
                  let browserInstanceId = payload["browserInstanceId"] as? String,
                  let success = payload["success"] as? Bool {
            // Store only the non-secret completion receipt. The `text` value
            // never belongs in this response and is never persisted.
            responseStore?.set([
                "requestId": requestId,
                "browserInstanceId": browserInstanceId,
                "success": success,
                "errorCode": payload["errorCode"] as? String ?? ""
            ], forKey: "marshal.safari.response.\(requestId)")
            responseStore?.synchronize()
            response.userInfo = [SFExtensionMessageKey: ["accepted": true]]
        } else {
            response.userInfo = [SFExtensionMessageKey: [
                "accepted": false,
                "errorCode": "SAFARI_NATIVE_MESSAGE_UNKNOWN"
            ]]
        }
        context.completeRequest(returningItems: [response])
    }
}
