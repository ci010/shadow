package app.shadow.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "ShadowCredentials")
public class ShadowCredentialsPlugin extends Plugin {
    private static final String ALIAS = "app.shadow.mobile.credentials.v1";
    private static final int MAX_BYTES = 16 * 1024;

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("shadow_credentials", Context.MODE_PRIVATE);
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return (SecretKey) store.getKey(ALIAS, null);
        }
        if (!create) throw new IllegalStateException("Credential encryption key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public synchronized void get(PluginCall call) {
        try {
            String record = preferences().getString("record", null);
            JSObject result = new JSObject();
            if (record == null) {
                result.put("value", JSONObject.NULL);
            } else {
                JSONObject envelope = new JSONObject(record);
                if (envelope.getInt("version") != 1) throw new IllegalStateException("Unknown credential format");
                byte[] iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP);
                byte[] ciphertext = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP);
                if (iv.length != 12 || ciphertext.length > MAX_BYTES + 16) {
                    throw new IllegalStateException("Invalid credential envelope");
                }
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
                cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
                result.put("value", new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Secure credential read failed; remove and pair again.", "SECURE_STORAGE_READ_FAILED");
        }
    }

    @PluginMethod
    public synchronized void set(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            call.reject("Credential value must be a string of at most 16384 UTF-8 bytes.", "INVALID_CREDENTIAL");
            return;
        }
        try {
            SharedPreferences prefs = preferences();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(!prefs.contains("record")));
            cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
            JSONObject envelope = new JSONObject();
            envelope.put("version", 1);
            envelope.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
            envelope.put("ciphertext", Base64.encodeToString(
                cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP
            ));
            if (!prefs.edit().putString("record", envelope.toString()).commit()) {
                throw new IllegalStateException("Credential persistence failed");
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Secure credential write failed.", "SECURE_STORAGE_WRITE_FAILED");
        }
    }

    @PluginMethod
    public synchronized void remove(PluginCall call) {
        try {
            if (!preferences().edit().remove("record").commit()) {
                throw new IllegalStateException("Credential removal failed");
            }
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(ALIAS);
            call.resolve();
        } catch (Exception error) {
            call.reject("Secure credential removal failed.", "SECURE_STORAGE_REMOVE_FAILED");
        }
    }
}
