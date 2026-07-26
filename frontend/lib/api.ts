const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_API_URL = "http://localhost:8000";
const SERVER_API_URL = "http://47.108.66.169:8000";

export function getApiUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  if (typeof window !== "undefined" && LOCAL_HOSTS.has(window.location.hostname)) {
    return LOCAL_API_URL;
  }
  return SERVER_API_URL;
}
