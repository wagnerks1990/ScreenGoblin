package com.screengoblin.player;

import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.ProviderException;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "DeviceIdentity")
public final class DeviceIdentityPlugin extends Plugin {
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "screengoblin-device-identity-v1";
    private static final int MIN_CHALLENGE_BYTES = 16;
    private static final int MAX_CHALLENGE_BYTES = 512;
    private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final Object KEY_LOCK = new Object();

    @PluginMethod
    public void getIdentity(PluginCall call) {
        try {
            KeyPair keyPair = getOrCreateKeyPair();
            byte[] publicKey = keyPair.getPublic().getEncoded();
            JSObject result = new JSObject();
            result.put("publicKeySpki", DeviceProofProtocol.base64Url(publicKey));
            result.put("keyId", DeviceProofProtocol.keyId(publicKey));
            result.put("algorithm", "ES256");
            result.put("securityLevel", securityLevel(keyPair.getPrivate()));
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Unable to access the device identity key", exception);
        }
    }

    @PluginMethod
    public void signChallenge(PluginCall call) {
        String encodedChallenge = call.getString("challenge");
        if (encodedChallenge == null || !BASE64URL.matcher(encodedChallenge).matches()) {
            call.reject("challenge must be unpadded base64url");
            return;
        }

        final byte[] challenge;
        try {
            challenge = Base64.decode(encodedChallenge, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        } catch (IllegalArgumentException exception) {
            call.reject("challenge must be unpadded base64url");
            return;
        }
        if (!DeviceProofProtocol.base64Url(challenge).equals(encodedChallenge)) {
            call.reject("challenge must be canonical unpadded base64url");
            return;
        }
        if (challenge.length < MIN_CHALLENGE_BYTES || challenge.length > MAX_CHALLENGE_BYTES) {
            call.reject("challenge must decode to between 16 and 512 bytes");
            return;
        }

        try {
            KeyPair keyPair = getOrCreateKeyPair();
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(keyPair.getPrivate());
            signer.update(DeviceProofProtocol.signingInput(challenge));

            byte[] publicKey = keyPair.getPublic().getEncoded();
            JSObject result = new JSObject();
            result.put("signature", DeviceProofProtocol.base64Url(signer.sign()));
            result.put("signatureFormat", "ES256-DER");
            result.put("keyId", DeviceProofProtocol.keyId(publicKey));
            call.resolve(result);
        } catch (Exception exception) {
            call.reject("Unable to sign the device challenge", exception);
        }
    }

    private KeyPair getOrCreateKeyPair() throws Exception {
        synchronized (KEY_LOCK) {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
            keyStore.load(null);
            if (!keyStore.containsAlias(KEY_ALIAS)) {
                boolean strongBoxAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
                try {
                    generateKey(strongBoxAvailable);
                } catch (ProviderException exception) {
                    if (!strongBoxAvailable) throw exception;
                    // Some devices advertise StrongBox but exhaust or reject it. Fall back
                    // to the device's TEE-backed Android Keystore provider.
                    generateKey(false);
                }
                keyStore.load(null);
            }

            KeyStore.PrivateKeyEntry entry = (KeyStore.PrivateKeyEntry) keyStore.getEntry(KEY_ALIAS, null);
            if (entry == null) throw new IllegalStateException("Device identity key is unavailable");
            return new KeyPair(entry.getCertificate().getPublicKey(), entry.getPrivateKey());
        }
    }

    private void generateKey(boolean useStrongBox) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEY_STORE);
        KeyGenParameterSpec.Builder parameters = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN
        )
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            parameters.setIsStrongBoxBacked(useStrongBox);
        }
        generator.initialize(parameters.build());
        generator.generateKeyPair();
    }

    private String securityLevel(PrivateKey privateKey) {
        try {
            KeyFactory factory = KeyFactory.getInstance(privateKey.getAlgorithm(), ANDROID_KEY_STORE);
            KeyInfo info = factory.getKeySpec(privateKey, KeyInfo.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                switch (info.getSecurityLevel()) {
                    case KeyProperties.SECURITY_LEVEL_STRONGBOX:
                        return "strongbox";
                    case KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT:
                        return "trusted-environment";
                    case KeyProperties.SECURITY_LEVEL_SOFTWARE:
                        return "software";
                    default:
                        return "unknown-secure";
                }
            }
            return info.isInsideSecureHardware() ? "trusted-environment" : "software";
        } catch (Exception ignored) {
            return "unknown";
        }
    }

}
