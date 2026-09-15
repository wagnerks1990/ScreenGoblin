package com.screengoblin.player;

import android.os.StatFs;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.regex.Pattern;

/** Crash-safe, content-addressed storage for player media. */
final class MediaCacheStore {
    static final long MAX_ASSET_BYTES = 128L * 1024L * 1024L;
    static final long MIN_SAFETY_RESERVE_BYTES = 64L * 1024L * 1024L;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long MAX_DOWNLOAD_DURATION_MS = 10L * 60L * 1000L;
    private static final int BUFFER_BYTES = 64 * 1024;
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern MEDIA_CAPABILITY = Pattern.compile("^[A-Za-z0-9_-]{1,4052}\\.[A-Za-z0-9_-]{43}$");
    private static final Pattern FINAL_NAME = Pattern.compile("^([0-9a-f]{64})\\.([a-z0-9]+)$");
    private static final Map<String, String> EXTENSIONS;

    static {
        Map<String, String> extensions = new HashMap<>();
        extensions.put("image/jpeg", "jpg");
        extensions.put("image/png", "png");
        extensions.put("video/mp4", "mp4");
        extensions.put("application/json", "json");
        EXTENSIONS = Collections.unmodifiableMap(extensions);
    }

    static final class CacheException extends Exception {
        final String code;

        CacheException(String code, String message) {
            super(message);
            this.code = code;
        }

        CacheException(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    static final class Asset {
        final String assetId;
        final URL url;
        final String mediaCapability;
        final String mimeType;
        final String sha256;
        final long sizeBytes;

        private Asset(String assetId, URL url, String mediaCapability, String mimeType, String sha256, long sizeBytes) {
            this.assetId = assetId;
            this.url = url;
            this.mediaCapability = mediaCapability;
            this.mimeType = mimeType;
            this.sha256 = sha256;
            this.sizeBytes = sizeBytes;
        }

        static Asset forPrefetch(
            String assetId,
            String rawUrl,
            String mediaCapability,
            String mimeType,
            String sha256,
            Long sizeBytes,
            boolean allowDebugLocalhostHttp
        ) throws CacheException {
            requireAssetId(assetId);
            extensionFor(mimeType);
            validateDigestAndSize(sha256, sizeBytes);
            URL url = validateUrl(rawUrl, allowDebugLocalhostHttp);
            if (mediaCapability == null || !MEDIA_CAPABILITY.matcher(mediaCapability).matches()) {
                throw invalid("mediaCapability is invalid");
            }
            return new Asset(assetId, url, mediaCapability, mimeType.toLowerCase(Locale.ROOT), sha256, sizeBytes);
        }

        static void validateResolve(String assetId, String mimeType, String sha256, Long sizeBytes) throws CacheException {
            requireAssetId(assetId);
            extensionFor(mimeType);
            validateDigestAndSize(sha256, sizeBytes);
        }

        static String fileName(String mimeType, String sha256) throws CacheException {
            if (sha256 == null || !SHA256.matcher(sha256).matches()) {
                throw invalid("checksumSha256 must be lowercase hexadecimal SHA-256");
            }
            return sha256 + "." + extensionFor(mimeType);
        }

        static String retainedFileName(String assetId, String mimeType, String sha256) throws CacheException {
            requireAssetId(assetId);
            return fileName(mimeType, sha256);
        }

        String fileName() throws CacheException {
            return sha256 + "." + extensionFor(mimeType);
        }
    }

    private final File directory;
    private final Object reservationLock = new Object();
    private final Object[] assetLocks = new Object[32];
    private final ReentrantReadWriteLock lifecycleLock = new ReentrantReadWriteLock(true);
    private long reservedBytes;

    MediaCacheStore(File filesDirectory) throws CacheException {
        if (filesDirectory == null) throw invalid("files directory is unavailable");
        this.directory = new File(filesDirectory, "media-cache-v1");
        for (int index = 0; index < assetLocks.length; index++) assetLocks[index] = new Object();
        ensureDirectory();
        cleanupTemporaryFiles();
    }

    File prefetch(Asset asset) throws CacheException {
        lifecycleLock.readLock().lock();
        try {
            Object lock = assetLocks[(asset.fileName().hashCode() & 0x7fffffff) % assetLocks.length];
            synchronized (lock) {
                return prefetchLocked(asset);
            }
        } finally {
            lifecycleLock.readLock().unlock();
        }
    }

    private File prefetchLocked(Asset asset) throws CacheException {
        File destination = child(asset.fileName());
        if (isVerified(destination, asset.sha256, asset.sizeBytes)) return destination;

        reserve(asset.sizeBytes);
        File temporary = child(asset.fileName() + "." + UUID.randomUUID() + ".part");
        try {
            download(asset, temporary);
            // Os.rename is a same-filesystem atomic replacement on Android/Linux. The
            // old final remains addressable until the fully synced candidate replaces it.
            try {
                Os.rename(temporary.getAbsolutePath(), destination.getAbsolutePath());
            } catch (ErrnoException exception) {
                throw new CacheException("CACHE_IO", "Unable to activate downloaded media", exception);
            }
            fsyncDirectoryBestEffort();
            return destination;
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
            release(asset.sizeBytes);
        }
    }

    File resolve(String assetId, String mimeType, String sha256, Long sizeBytes) throws CacheException {
        lifecycleLock.readLock().lock();
        try {
            Asset.validateResolve(assetId, mimeType, sha256, sizeBytes);
            File candidate = child(Asset.fileName(mimeType, sha256));
            Object lock = assetLocks[(candidate.getName().hashCode() & 0x7fffffff) % assetLocks.length];
            synchronized (lock) {
                if (!candidate.isFile()) throw new CacheException("CACHE_MISS", "Media is not available in the native cache");
                if (!isVerified(candidate, sha256, sizeBytes)) {
                    throw new CacheException("INTEGRITY_FAILURE", "Cached media failed integrity verification");
                }
                return candidate;
            }
        } finally {
            lifecycleLock.readLock().unlock();
        }
    }

    void prune(Set<String> retainedFileNames) throws CacheException {
        lifecycleLock.writeLock().lock();
        try {
            for (File file : listFiles()) {
                if (FINAL_NAME.matcher(file.getName()).matches() && !retainedFileNames.contains(file.getName()) && !file.delete()) {
                    throw new CacheException("CACHE_IO", "Unable to prune cached media");
                }
            }
            fsyncDirectoryBestEffort();
        } finally {
            lifecycleLock.writeLock().unlock();
        }
    }

    void removeAll() throws CacheException {
        lifecycleLock.writeLock().lock();
        try {
            for (File file : listFiles()) {
                if ((FINAL_NAME.matcher(file.getName()).matches() || file.getName().endsWith(".part")) && !file.delete()) {
                    throw new CacheException("CACHE_IO", "Unable to remove cached media");
                }
            }
            fsyncDirectoryBestEffort();
        } finally {
            lifecycleLock.writeLock().unlock();
        }
    }

    long availableBytes() throws CacheException {
        lifecycleLock.readLock().lock();
        try {
            ensureDirectory();
            StatFs stats = new StatFs(directory.getAbsolutePath());
            long usable = stats.getAvailableBytes();
            synchronized (reservationLock) {
                return Math.max(0L, usable - safetyReserve(stats.getTotalBytes()) - reservedBytes);
            }
        } finally {
            lifecycleLock.readLock().unlock();
        }
    }

    private void download(Asset asset, File temporary) throws CacheException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) asset.url.openConnection();
            configureConnection(connection, asset.mediaCapability);
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new CacheException("DOWNLOAD_REJECTED", "Media server returned HTTP " + status);
            }
            validateContentEncoding(connection.getHeaderField("Content-Encoding"));
            long contentLength = parseContentLength(connection.getHeaderField("Content-Length"));
            if (contentLength > MAX_ASSET_BYTES || (contentLength >= 0L && contentLength != asset.sizeBytes)) {
                throw new CacheException("INTEGRITY_FAILURE", "Media response size does not match the manifest");
            }
            String responseMimeType = connection.getContentType();
            if (responseMimeType != null && !responseMimeType.split(";", 2)[0].trim().equalsIgnoreCase(asset.mimeType)) {
                throw new CacheException("INTEGRITY_FAILURE", "Media response type does not match the manifest");
            }

            MessageDigest digest = sha256();
            long total = 0L;
            long startedAtNanos = System.nanoTime();
            byte[] buffer = new byte[BUFFER_BYTES];
            try (
                InputStream input = new BufferedInputStream(connection.getInputStream(), BUFFER_BYTES);
                FileOutputStream output = new FileOutputStream(temporary)
            ) {
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if ((System.nanoTime() - startedAtNanos) / 1_000_000L > MAX_DOWNLOAD_DURATION_MS) {
                        throw new CacheException("DOWNLOAD_REJECTED", "Media download exceeded its total deadline");
                    }
                    total += count;
                    if (total > asset.sizeBytes || total > MAX_ASSET_BYTES) {
                        throw new CacheException("INTEGRITY_FAILURE", "Media response exceeds its declared size");
                    }
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (total != asset.sizeBytes || !hex(digest.digest()).equals(asset.sha256)) {
                throw new CacheException("INTEGRITY_FAILURE", "Media response failed integrity verification");
            }
        } catch (CacheException exception) {
            throw exception;
        } catch (IOException exception) {
            throw new CacheException("CACHE_IO", "Unable to download media", exception);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean isVerified(File file, String sha256, long sizeBytes) throws CacheException {
        if (!file.isFile() || file.length() != sizeBytes) return false;
        MessageDigest digest = sha256();
        byte[] buffer = new byte[BUFFER_BYTES];
        try (InputStream input = new BufferedInputStream(new FileInputStream(file), BUFFER_BYTES)) {
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        } catch (IOException exception) {
            throw new CacheException("CACHE_IO", "Unable to verify cached media", exception);
        }
        return hex(digest.digest()).equals(sha256);
    }

    private void reserve(long bytes) throws CacheException {
        synchronized (reservationLock) {
            StatFs stats = new StatFs(directory.getAbsolutePath());
            long available = Math.max(0L, stats.getAvailableBytes() - safetyReserve(stats.getTotalBytes()) - reservedBytes);
            if (bytes > available) throw new CacheException("INSUFFICIENT_STORAGE", "Insufficient safe storage for media");
            reservedBytes += bytes;
        }
    }

    private void release(long bytes) {
        synchronized (reservationLock) {
            reservedBytes = Math.max(0L, reservedBytes - bytes);
        }
    }

    private void ensureDirectory() throws CacheException {
        if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory()) {
            throw new CacheException("CACHE_IO", "Unable to initialize the media cache");
        }
    }

    private void cleanupTemporaryFiles() throws CacheException {
        for (File file : listFiles()) {
            if (file.getName().endsWith(".part") && !file.delete()) {
                throw new CacheException("CACHE_IO", "Unable to clean an incomplete media download");
            }
        }
        fsyncDirectoryBestEffort();
    }

    private File[] listFiles() throws CacheException {
        ensureDirectory();
        File[] files = directory.listFiles();
        if (files == null) throw new CacheException("CACHE_IO", "Unable to inspect the media cache");
        return files;
    }

    private File child(String name) throws CacheException {
        File file = new File(directory, name);
        try {
            if (!file.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile())) throw invalid("unsafe cache filename");
        } catch (IOException exception) {
            throw new CacheException("CACHE_IO", "Unable to resolve the media cache path", exception);
        }
        return file;
    }

    private void fsyncDirectoryBestEffort() {
        java.io.FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            Os.fsync(descriptor);
        } catch (ErrnoException ignored) {
            // Some Android filesystems do not support fsync on directory handles.
        } finally {
            if (descriptor != null) {
                try {
                    Os.close(descriptor);
                } catch (ErrnoException ignored) {
                    // Best effort only.
                }
            }
        }
    }

    static URL validateUrl(String rawUrl, boolean allowDebugLocalhostHttp) throws CacheException {
        if (rawUrl == null) throw invalid("url is required");
        try {
            URI uri = URI.create(rawUrl);
            if (!uri.isAbsolute() || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getHost() == null) {
                throw invalid("url must be an absolute media URL without credentials, query, or fragments");
            }
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            boolean debugLocalhost = allowDebugLocalhostHttp && scheme.equals("http") && isLocalhost(uri.getHost());
            if (!scheme.equals("https") && !debugLocalhost) throw invalid("url must use HTTPS");
            return uri.toURL();
        } catch (CacheException exception) {
            throw exception;
        } catch (IllegalArgumentException | IOException exception) {
            throw invalid("url is invalid");
        }
    }

    static void configureConnection(HttpURLConnection connection, String mediaCapability) throws CacheException {
        if (connection == null || mediaCapability == null || !MEDIA_CAPABILITY.matcher(mediaCapability).matches()) {
            throw invalid("media authorization is invalid");
        }
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Authorization", "MediaCapability " + mediaCapability);
    }

    static void validateContentEncoding(String value) throws CacheException {
        if (value != null && !value.equalsIgnoreCase("identity")) {
            throw new CacheException("INTEGRITY_FAILURE", "Media response encoding is not allowed");
        }
    }

    static String extensionFor(String mimeType) throws CacheException {
        if (mimeType == null) throw invalid("mimeType is required");
        String extension = EXTENSIONS.get(mimeType.toLowerCase(Locale.ROOT));
        if (extension == null) throw invalid("mimeType is not supported");
        return extension;
    }

    static long parseContentLength(String value) throws CacheException {
        if (value == null) return -1L;
        if (!value.matches("^(0|[1-9][0-9]*)$")) {
            throw new CacheException("INTEGRITY_FAILURE", "Media response Content-Length is invalid");
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException exception) {
            throw new CacheException("INTEGRITY_FAILURE", "Media response Content-Length is invalid", exception);
        }
    }

    private static void requireAssetId(String assetId) throws CacheException {
        if (assetId == null || assetId.isEmpty() || assetId.length() > 256 || !assetId.equals(assetId.trim())) {
            throw invalid("assetId is invalid");
        }
        for (int index = 0; index < assetId.length(); index++) {
            if (Character.isISOControl(assetId.charAt(index))) throw invalid("assetId is invalid");
        }
    }

    private static void validateDigestAndSize(String sha256, Long sizeBytes) throws CacheException {
        if (sha256 == null || !SHA256.matcher(sha256).matches()) throw invalid("checksumSha256 must be lowercase hexadecimal SHA-256");
        if (sizeBytes == null || sizeBytes < 1L || sizeBytes > MAX_ASSET_BYTES) throw invalid("sizeBytes is outside the supported range");
    }

    private static boolean isLocalhost(String host) {
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("localhost") || normalized.equals("127.0.0.1") || normalized.equals("::1") || normalized.equals("[::1]");
    }

    private static long safetyReserve(long totalBytes) {
        return Math.max(MIN_SAFETY_RESERVE_BYTES, totalBytes / 20L);
    }

    private static MessageDigest sha256() throws CacheException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new CacheException("CACHE_IO", "SHA-256 is unavailable", exception);
        }
    }

    private static String hex(byte[] bytes) {
        char[] alphabet = "0123456789abcdef".toCharArray();
        char[] encoded = new char[bytes.length * 2];
        for (int index = 0; index < bytes.length; index++) {
            int value = bytes[index] & 0xff;
            encoded[index * 2] = alphabet[value >>> 4];
            encoded[index * 2 + 1] = alphabet[value & 0x0f];
        }
        return new String(encoded);
    }

    private static CacheException invalid(String message) {
        return new CacheException("INVALID_ARGUMENT", message);
    }
}
