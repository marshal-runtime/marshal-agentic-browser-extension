# Marshal Safari native bridge

The Safari Web Extension must be packaged inside a signed macOS containing app. Apple’s Safari Web Extension model has three separately sandboxed pieces: the containing app, JavaScript running in Safari, and the native app extension. Native messaging and app groups are the supported bridge between them.

This directory contains the source for the native side. Run the converter from the repository root after building the Safari extension:

```sh
npm run build:safari-extension
xcrun safari-web-extension-converter packages/safari-extension/build \
  --project-location native/safari-xcode \
  --app-name "Marshal Safari Bridge"
```

The same operation is available as `npm run package:safari` after full Xcode
has been installed and selected with `xcode-select`.

Then add `native/safari/MarshalSafariBridge.swift` to the generated containing-app target and `native/safari/SafariWebExtensionHandler.swift` to the generated Safari Web Extension Handler target. Configure the same shared App Group (`group.com.marshal.agentic-browser`) for both targets. The containing app calls `sendSecretType`; the native extension writes only the boolean completion receipt into the App Group, and the containing app consumes it.

The native layer must never persist or log the `text` field. It only forwards it transiently to the extension port and returns a boolean/error code.
