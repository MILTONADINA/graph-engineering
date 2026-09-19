# authentication/refresh-token — intentionally empty

Refresh token issuance, storage, and rotation are implemented inside [`authentication.jwt`](../jwt/), not as a separate node — see that template's `README.md` ("Why access and refresh tokens use different mechanisms") for the design and `REFERENCE_ARCHITECTURE.md` §8 for the gap this fills (the reference app's README promised a refresh token that was never implemented).

This directory is kept as a placeholder (rather than deleted) so the original category sketch's `authentication/refresh-token/` slot is visibly accounted for, not silently missing.
