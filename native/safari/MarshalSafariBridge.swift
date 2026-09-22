import Foundation
import SafariServices

/// App-side bridge used by the signed Marshal containing app.
///
/// The desktop Marshal host should call `sendSecretType` after it has resolved
/// the KeyVault entry and enforced the time window. The request contains the
/// secret only in memory and is dispatched to the already-installed Safari
/// extension. The extension replies on its native port; the host should treat
/// any response other than `success == true` as a failure.
public final class MarshalSafariBridge: NSObject {
    public static let messageName = "marshal.keyvault.typeSecret"
    public static let responseStore = "group.com.marshal.agentic-browser"

    private let extensionBundleIdentifier: String

    public init(extensionBundleIdentifier: String) {
        self.extensionBundleIdentifier = extensionBundleIdentifier
    }

    public func sendSecretType(
        request: [String: Any],
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard let requestId = request["requestId"] as? String, !requestId.isEmpty else {
            completion(.failure(BridgeError.invalidRequest))
            return
        }
        guard request["kind"] as? String == Self.messageName,
              request["browserInstanceId"] as? String != nil,
              request["selector"] as? String != nil,
              request["fieldKind"] as? String != nil,
              request["text"] as? String != nil else {
            completion(.failure(BridgeError.invalidRequest))
            return
        }

        SFSafariApplication.dispatchMessage(
            withName: Self.messageName,
            toExtensionWithIdentifier: extensionBundleIdentifier,
            userInfo: request
        ) { error in
            if let error {
                completion(.failure(error))
            } else {
                self.waitForResponse(requestId: requestId, deadline: Date().addingTimeInterval(30), completion: completion)
            }
        }
    }

    private func waitForResponse(
        requestId: String,
        deadline: Date,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        consumeResponse(requestId: requestId) { result in
            switch result {
            case .success(let success):
                completion(success ? .success(()) : .failure(BridgeError.secretTypeRejected))
            case .failure(let error) where (error as? BridgeError) == .responsePending && Date() < deadline:
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self.waitForResponse(requestId: requestId, deadline: deadline, completion: completion)
                }
            case .failure(let error):
                completion(.failure(error))
            }
        }
    }

    /// Reads and consumes the completion receipt written by the native app
    /// extension after the Safari content script has validated and filled the
    /// field. Only the boolean outcome is shared through the App Group.
    public func consumeResponse(
        requestId: String,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        guard let defaults = UserDefaults(suiteName: Self.responseStore),
              let response = defaults.dictionary(forKey: "marshal.safari.response.\(requestId)"),
              let success = response["success"] as? Bool else {
            completion(.failure(BridgeError.responsePending))
            return
        }
        defaults.removeObject(forKey: "marshal.safari.response.\(requestId)")
        completion(.success(success))
    }

    public enum BridgeError: Error, Equatable {
        case invalidRequest
        case responsePending
        case secretTypeRejected
    }
}
