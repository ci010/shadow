import Capacitor
import Foundation
import Security

@objc(ShadowCredentialsPlugin)
public class ShadowCredentialsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShadowCredentialsPlugin"
    public let jsName = "ShadowCredentials"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "app.shadow.mobile.credentials.v1",
            kSecAttrAccount as String: "connection",
            kSecAttrSynchronizable as String: false
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else if status == errSecSuccess,
                  let data = result as? Data,
                  data.count <= 16 * 1024,
                  let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else {
            call.reject("Secure credential read failed; remove and pair again.", "SECURE_STORAGE_READ_FAILED")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"),
              let data = value.data(using: .utf8),
              data.count <= 16 * 1024 else {
            call.reject("Credential value must be a string of at most 16384 UTF-8 bytes.", "INVALID_CREDENTIAL")
            return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Secure credential write failed.", "SECURE_STORAGE_WRITE_FAILED")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Secure credential removal failed.", "SECURE_STORAGE_REMOVE_FAILED")
        }
    }
}
