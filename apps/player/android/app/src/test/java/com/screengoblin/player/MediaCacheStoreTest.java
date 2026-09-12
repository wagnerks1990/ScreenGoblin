package com.screengoblin.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class MediaCacheStoreTest {
    private static final String DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    public void canonicalFileNamesUseOnlyTheMimeAllowlist() throws Exception {
        assertEquals(DIGEST + ".jpg", MediaCacheStore.Asset.fileName("image/jpeg", DIGEST));
        assertEquals(DIGEST + ".png", MediaCacheStore.Asset.fileName("IMAGE/PNG", DIGEST));
        assertEquals(DIGEST + ".mp4", MediaCacheStore.Asset.fileName("video/mp4", DIGEST));
        assertEquals(DIGEST + ".json", MediaCacheStore.Asset.fileName("application/json", DIGEST));

        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.Asset.fileName("image/svg+xml", DIGEST));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.Asset.fileName("image/jpeg; charset=utf-8", DIGEST));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.Asset.fileName("image/jpeg", DIGEST.toUpperCase()));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.Asset.retainedFileName(" asset-1", "image/jpeg", DIGEST));
    }

    @Test
    public void productionUrlsAreHttpsWithoutCredentialsOrFragments() throws Exception {
        assertEquals("https", MediaCacheStore.validateUrl("https://media.example.test/item.mp4", false).getProtocol());
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.validateUrl("http://media.example.test/item.mp4", false));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.validateUrl("https://user:secret@media.example.test/item.mp4", false));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.validateUrl("https://media.example.test/item.mp4#fragment", false));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.validateUrl("file:///data/local/item.mp4", false));
    }

    @Test
    public void debugHttpExceptionIsLimitedToExplicitLoopbackHosts() throws Exception {
        assertEquals("http", MediaCacheStore.validateUrl("http://localhost:3000/item.mp4", true).getProtocol());
        assertEquals("http", MediaCacheStore.validateUrl("http://127.0.0.1:3000/item.mp4", true).getProtocol());
        assertEquals("http", MediaCacheStore.validateUrl("http://[::1]:3000/item.mp4", true).getProtocol());
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.validateUrl("http://localhost.example.test/item.mp4", true));
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.validateUrl("http://192.168.1.2/item.mp4", true));
    }

    @Test
    public void manifestIdentityMustBeCanonicalAndBounded() throws Exception {
        MediaCacheStore.Asset asset = MediaCacheStore.Asset.forPrefetch(
            "asset-1",
            "https://media.example.test/item.mp4",
            "video/mp4",
            DIGEST,
            1L,
            false
        );
        assertEquals(DIGEST + ".mp4", asset.fileName());

        assertInvalidSize(0L);
        assertInvalidSize(MediaCacheStore.MAX_ASSET_BYTES + 1L);
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.Asset.forPrefetch(
            "asset-1", "https://media.example.test/item.mp4", "video/mp4", DIGEST.toUpperCase(), 1L, false
        ));
    }

    @Test
    public void contentLengthParsingRejectsAmbiguousOrOverflowValues() throws Exception {
        assertEquals(-1L, MediaCacheStore.parseContentLength(null));
        assertEquals(0L, MediaCacheStore.parseContentLength("0"));
        assertEquals(128L, MediaCacheStore.parseContentLength("128"));
        assertCode("INTEGRITY_FAILURE", () -> MediaCacheStore.parseContentLength(" 128"));
        assertCode("INTEGRITY_FAILURE", () -> MediaCacheStore.parseContentLength("128, 128"));
        assertCode("INTEGRITY_FAILURE", () -> MediaCacheStore.parseContentLength("9223372036854775808"));
    }

    private static void assertInvalidSize(long size) throws Exception {
        assertCode("INVALID_ARGUMENT", () -> MediaCacheStore.Asset.forPrefetch(
            "asset-1", "https://media.example.test/item.mp4", "video/mp4", DIGEST, size, false
        ));
    }

    private static void assertCode(String expected, ThrowingOperation operation) throws Exception {
        try {
            operation.run();
            fail("Expected cache exception " + expected);
        } catch (MediaCacheStore.CacheException exception) {
            assertEquals(expected, exception.code);
            assertTrue(exception.getMessage().length() > 0);
        }
    }

    private interface ThrowingOperation {
        void run() throws Exception;
    }
}
