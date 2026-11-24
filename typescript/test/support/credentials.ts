/**
 * The patterns the example tests use to decide that output leaked a credential. Shared by the unit tier, which
 * pins what they permit, and the example tier, which sweeps every child process's output with them. Both port
 * `_CREDENTIALED_URI` and `_URI_PASSWORDS` from `python/tests/test_examples.py`.
 */

/**
 * Any URI carrying credentials, in either scheme, except the exact redaction `redact` writes.
 *
 * The lookahead permits `<redacted>@` only when no second `@` follows it, which is what a redaction that stops
 * at the first `@` of `p@ss` leaves behind. `\S*` rather than `[^\s/]*`, because a password pasted without
 * percent-encoding can hold a `/`, and a pattern that stops at the first one does not see that URI at all.
 */
export const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/(?!<redacted>@[^\s@]*(?:\s|$))\S*@/

/**
 * The password in a URI, read two ways because an `@` after the authority makes the userinfo ambiguous: up to
 * the last `@` anywhere, and up to the last `@` before the first `/` or `?`.
 */
const URI_PASSWORDS = [/:\/\/[^:@/]+:(.+)@/, /:\/\/[^:@/]+:([^/?]+)@/]

/**
 * Every reading of the password in `uri`, for a check that none of them reached the output.
 *
 * @param uri - The connection string a run was given.
 * @returns Each reading `URI_PASSWORDS` finds, which is none for a URI without a password.
 */
export function uriPasswords(uri: string): string[] {
  return URI_PASSWORDS.flatMap((pattern) => pattern.exec(uri)?.[1] ?? [])
}
