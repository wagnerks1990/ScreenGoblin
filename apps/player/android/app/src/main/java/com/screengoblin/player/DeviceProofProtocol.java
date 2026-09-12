package com.screengoblin.player;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class DeviceProofProtocol {
    private static final byte[] SIGNING_DOMAIN =
        "ScreenGoblin device proof v1\0".getBytes(StandardCharsets.UTF_8);
    private static final char[] BASE64URL =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    private DeviceProofProtocol() {}

    static byte[] signingInput(byte[] challenge) {
        byte[] result = new byte[SIGNING_DOMAIN.length + challenge.length];
        System.arraycopy(SIGNING_DOMAIN, 0, result, 0, SIGNING_DOMAIN.length);
        System.arraycopy(challenge, 0, result, SIGNING_DOMAIN.length, challenge.length);
        return result;
    }

    static String keyId(byte[] spki) throws Exception {
        return base64Url(MessageDigest.getInstance("SHA-256").digest(spki));
    }

    static String base64Url(byte[] value) {
        StringBuilder result = new StringBuilder((value.length * 4 + 2) / 3);
        for (int index = 0; index < value.length; index += 3) {
            int first = value[index] & 0xff;
            int second = index + 1 < value.length ? value[index + 1] & 0xff : 0;
            int third = index + 2 < value.length ? value[index + 2] & 0xff : 0;
            result.append(BASE64URL[first >>> 2]);
            result.append(BASE64URL[((first & 0x03) << 4) | (second >>> 4)]);
            if (index + 1 < value.length)
                result.append(BASE64URL[((second & 0x0f) << 2) | (third >>> 6)]);
            if (index + 2 < value.length) result.append(BASE64URL[third & 0x3f]);
        }
        return result.toString();
    }
}
