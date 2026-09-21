import Capacitor

class ShadowViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShadowCredentialsPlugin())
    }
}
