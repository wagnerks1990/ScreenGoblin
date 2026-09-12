package com.screengoblin.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

public final class DeviceProofProtocolTest {
    @Test
    public void signingInputHasStableDomainAndZeroSeparator() {
        byte[] challenge = new byte[] {0x01, 0x02, (byte) 0xff};

        assertArrayEquals(
            concat("ScreenGoblin device proof v1\0".getBytes(StandardCharsets.UTF_8), challenge),
            DeviceProofProtocol.signingInput(challenge)
        );
    }

    @Test
    public void base64UrlIsUnpaddedAndUsesUrlAlphabet() {
        assertEquals("", DeviceProofProtocol.base64Url(new byte[0]));
        assertEquals("Zg", DeviceProofProtocol.base64Url("f".getBytes(StandardCharsets.UTF_8)));
        assertEquals("Zm8", DeviceProofProtocol.base64Url("fo".getBytes(StandardCharsets.UTF_8)));
        assertEquals("Zm9v", DeviceProofProtocol.base64Url("foo".getBytes(StandardCharsets.UTF_8)));
        assertEquals("-_8", DeviceProofProtocol.base64Url(new byte[] {(byte) 0xfb, (byte) 0xff}));
    }

    @Test
    public void keyIdIsStableSha256OfExactSpkiBytes() throws Exception {
        assertEquals(
            "q9YgerAwudEl8aPB6EHFOrfu1A5IDLIqNHAr4Zqw8J4",
            DeviceProofProtocol.keyId("test-spki".getBytes(StandardCharsets.UTF_8))
        );
    }

    private static byte[] concat(byte[] first, byte[] second) {
        byte[] result = new byte[first.length + second.length];
        System.arraycopy(first, 0, result, 0, first.length);
        System.arraycopy(second, 0, result, first.length, second.length);
        return result;
    }
}
