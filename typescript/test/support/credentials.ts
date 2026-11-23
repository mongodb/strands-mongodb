/**
 * The one pattern the example tests use to decide that output leaked a credential. Shared by the unit tier,
 * which pins what it permits, and the example tier, which sweeps every child process's output with it.
 */

/** Any URI carrying credentials, in either scheme, except the exact redaction `redact` writes. */
export const CREDENTIALED_URI = /mongodb(\+srv)?:\/\/(?!<redacted>@)[^\s/]*@/
