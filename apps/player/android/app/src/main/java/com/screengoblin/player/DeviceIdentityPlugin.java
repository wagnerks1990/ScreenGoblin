package com.screengoblin.player;

import android.content.pm.PackageManager;
import android.content.SharedPreferences;
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
import java.util.Enumeration;

@CapacitorPlugin(name = "DeviceIdentity")
public final class DeviceIdentityPlugin extends Plugin {
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String LEGACY_KEY_ALIAS = "screengoblin-device-identity-v1";
    private static final String PREFERENCES = "device-identity";
    private static final String ACTIVE_ALIAS = "active-alias";
    private static final int MIN_CHALLENGE_BYTES = 16;
    private static final int MAX_CHALLENGE_BYTES = 512;
    private static final Pattern BASE64URL = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final Object KEY_LOCK = new Object();

    @PluginMethod
    public void getIdentity(PluginCall call) {
        try {
            KeyPair keyPair = getOrCreateKeyPair();
            call.resolve(identity(keyPair));
        } catch (Exception exception) {
            call.reject("Unable to access the device identity key", exception);
        }
    }

    @PluginMethod
    public void rotateIdentity(PluginCall call) {
        synchronized (KEY_LOCK) {
            String candidateAlias = DeviceIdentityAliases.freshAlias();
            try {
                generateKey(candidateAlias, strongBoxAvailable());
                KeyStore keyStore = loadKeyStore();
                KeyPair candidate = keyPair(keyStore, candidateAlias);
                JSObject candidateIdentity = identity(candidate);
                if (!preferences().edit().putString(ACTIVE_ALIAS, candidateAlias).commit()) {
                    keyStore.deleteEntry(candidateAlias);
                    throw new IllegalStateException("Unable to persist the replacement identity");
                }
                // Retain the prior private key. This makes the pointer update recoverable
                // and prevents a generation failure from destroying the enrolled identity.
                call.resolve(candidateIdentity);
            } catch (Exception exception) {
                try {
                    KeyStore keyStore = loadKeyStore();
                    if (keyStore.containsAlias(candidateAlias)) keyStore.deleteEntry(candidateAlias);
                } catch (Exception ignored) {
                    // Preserve the original error; an unreferenced candidate is never used.
                }
                call.reject("Unable to replace the device identity key", exception);
            }
        }
    }

    @PluginMethod
    public void finalizeIdentityRotation(PluginCall call) {
        String expectedKeyId = call.getString("keyId");
        if (expectedKeyId == null || !BASE64URL.matcher(expectedKeyId).matches()) {
            call.reject("keyId must be canonical unpadded base64url");
            return;
        }
        synchronized (KEY_LOCK) {
            try {
                KeyStore keyStore = loadKeyStore();
                String activeAlias = preferences().getString(ACTIVE_ALIAS, null);
                if (activeAlias == null || !DeviceIdentityAliases.isManagedAlias(activeAlias))
                    throw new IllegalStateException("Active device identity alias is unavailable");
                KeyPair active = keyPair(keyStore, activeAlias);
                if (!DeviceProofProtocol.keyId(active.getPublic().getEncoded()).equals(expectedKeyId))
                    throw new IllegalStateException("Active device identity does not match the activated credential");

                Enumeration<String> aliases = keyStore.aliases();
                while (aliases.hasMoreElements()) {
                    String alias = aliases.nextElement();
                    if (DeviceIdentityAliases.shouldDeleteAfterActivation(alias, activeAlias))
                        keyStore.deleteEntry(alias);
                }
                call.resolve();
            } catch (Exception exception) {
                call.reject("Unable to remove superseded device identity keys", exception);
            }
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
            KeyStore keyStore = loadKeyStore();
            String alias = preferences().getString(ACTIVE_ALIAS, null);
            boolean generated = false;
            if (alias != null && !DeviceIdentityAliases.isManagedAlias(alias))
                throw new IllegalStateException("Stored device identity alias is invalid");
            if (alias == null && keyStore.containsAlias(LEGACY_KEY_ALIAS)) alias = LEGACY_KEY_ALIAS;
            if (alias == null || !keyStore.containsAlias(alias)) {
                alias = DeviceIdentityAliases.freshAlias();
                generateKey(alias, strongBoxAvailable());
                keyStore = loadKeyStore();
                generated = true;
            }
            if (!preferences().edit().putString(ACTIVE_ALIAS, alias).commit()) {
                if (generated) keyStore.deleteEntry(alias);
                throw new IllegalStateException("Unable to persist the active identity");
            }
            return keyPair(keyStore, alias);
        }
    }

    private void generateKey(String alias, boolean preferStrongBox) throws Exception {
        try {
            generateKeyOnce(alias, preferStrongBox);
        } catch (ProviderException exception) {
            if (!preferStrongBox) throw exception;
            KeyStore keyStore = loadKeyStore();
            if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias);
            generateKeyOnce(alias, false);
        }
    }

    private void generateKeyOnce(String alias, boolean useStrongBox) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEY_STORE);
        KeyGenParameterSpec.Builder parameters = new KeyGenParameterSpec.Builder(
            alias,
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

    private boolean strongBoxAvailable() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, 0);
    }

    private KeyStore loadKeyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        return keyStore;
    }

    private KeyPair keyPair(KeyStore keyStore, String alias) throws Exception {
        KeyStore.PrivateKeyEntry entry = (KeyStore.PrivateKeyEntry) keyStore.getEntry(alias, null);
        if (entry == null) throw new IllegalStateException("Device identity key is unavailable");
        return new KeyPair(entry.getCertificate().getPublicKey(), entry.getPrivateKey());
    }

    private JSObject identity(KeyPair keyPair) throws Exception {
        byte[] publicKey = keyPair.getPublic().getEncoded();
        JSObject result = new JSObject();
        result.put("publicKeySpki", DeviceProofProtocol.base64Url(publicKey));
        result.put("keyId", DeviceProofProtocol.keyId(publicKey));
        result.put("algorithm", "ES256");
        result.put("securityLevel", securityLevel(keyPair.getPrivate()));
        return result;
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
