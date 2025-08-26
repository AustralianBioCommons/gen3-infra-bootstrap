export function bucketSafeFromHostname(hostname: string): string {
  // Lowercase, replace dots with hyphens, strip invalid chars, trim, and cap to 63 chars
  return hostname
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\./g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 63);
}
