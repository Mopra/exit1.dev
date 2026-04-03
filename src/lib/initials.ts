/**
 * Derive 1–2 character initials from a name or email address.
 *
 * If `name` contains a space it is treated as a full name (e.g. "Jane Doe" → "JD").
 * Otherwise the first two characters of `name` are used.
 * Falls back to the local part of `email`, then to "U".
 */
export function getInitials(name?: string, email?: string): string {
  if (name) {
    if (name.includes(" ")) {
      return name
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase())
        .join("")
        .slice(0, 2)
    }
    if (name.length >= 2) return name.slice(0, 2).toUpperCase()
    return name[0].toUpperCase()
  }
  if (email) {
    const local = email.split("@")[0]
    if (local.length >= 2) return local.slice(0, 2).toUpperCase()
    return email[0].toUpperCase()
  }
  return "U"
}
