const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const hasMediaUrlCredentials = (url: URL): boolean =>
  Boolean(url.username || url.password);

export const usesAllowedMediaScheme = (url: URL): boolean =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && loopbackHosts.has(url.hostname));

export const mediaUrlMatchesAllowedOrigin = (
  value: string,
  allowedOrigins: readonly string[],
): boolean => {
  try {
    const url = new URL(value);
    return (
      !hasMediaUrlCredentials(url) &&
      usesAllowedMediaScheme(url) &&
      allowedOrigins.includes(url.origin)
    );
  } catch {
    return false;
  }
};
